package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// The packages whose calls carry text for the user.
const (
	i18nPath = "github.com/rclone/rclone-ui/core/i18n"
	errsPath = "github.com/rclone/rclone-ui/core/errs"
)

// call gives the positions of a function's arguments: the English format, the plural form, and
// the context (-1 when the function has none).
type call struct{ format, plural, ctx int }

// calls lists the functions that take a message, by package path and name.
var calls = map[string]map[string]call{
	i18nPath: {
		"T": {0, -1, -1}, "M": {0, -1, -1},
		"N": {0, 1, -1}, "MN": {0, 1, -1},
		"TC": {1, -1, 0}, "MC": {1, -1, 0},
	},
	errsPath: {
		"New": {0, -1, -1}, "Errorf": {0, -1, -1}, "Precondition": {0, -1, -1}, "Canceled": {0, -1, -1},
		"Field": {1, -1, -1}, "NotFound": {1, -1, -1}, "Unsupported": {1, -1, -1}, "Violation": {1, -1, -1},
	},
}

type message struct {
	ctx, id, plural string
	notes           []string
	files           map[string]bool
}

type extraction struct {
	messages map[string]*message
	problems []string
}

// roots are the folders of the Go code that shows text, relative to the repository.
var roots = []string{"app", "core", "main.go"}

// extract collects the messages of the calls in `calls` from every Go file under dir's roots. It
// only parses the files, so it also reads the files that are built for other systems. A message
// must be a string constant, because a message that is put together at run time has no
// translation to look up.
func extract(dir string) (*extraction, error) {
	x := &extraction{messages: map[string]*message{}}
	var files []string
	for _, root := range roots {
		err := filepath.WalkDir(filepath.Join(dir, root), func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
				return nil
			}
			files = append(files, p)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Strings(files)
	fset := token.NewFileSet()
	// A message may be a constant of its package, declared in any of its files.
	parsed := map[string]*ast.File{}
	consts := map[string]map[string]string{} // folder -> constant -> value
	for _, p := range files {
		f, err := parser.ParseFile(fset, p, nil, parser.ParseComments|parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		parsed[p] = f
		folder := filepath.Dir(p)
		if consts[folder] == nil {
			consts[folder] = map[string]string{}
		}
		collectConsts(f, consts[folder])
	}
	for _, p := range files {
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		// core/errs is skipped, because its own calls only pass a caller's message on. core/i18n
		// is read, because it also has messages of its own (a list's "and"), which it calls
		// without the package's name.
		if strings.HasPrefix(rel, "core/errs/") {
			continue
		}
		x.file(fset, parsed[p], rel, consts[filepath.Dir(p)], strings.HasPrefix(rel, "core/i18n/"))
	}
	sort.Strings(x.problems)
	return x, nil
}

func collectConsts(f *ast.File, out map[string]string) {
	for _, d := range f.Decls {
		g, ok := d.(*ast.GenDecl)
		if !ok || g.Tok != token.CONST {
			continue
		}
		for _, spec := range g.Specs {
			v := spec.(*ast.ValueSpec)
			for i, name := range v.Names {
				if i < len(v.Values) {
					if s, ok := constant(v.Values[i], nil); ok {
						out[name.Name] = s
					}
				}
			}
		}
	}
}

// constant returns the value of a string constant: a literal, a constant of the package, or
// several of them joined with +.
func constant(e ast.Expr, consts map[string]string) (string, bool) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(v.Value)
		return s, err == nil
	case *ast.Ident:
		s, ok := consts[v.Name]
		return s, ok
	case *ast.ParenExpr:
		return constant(v.X, consts)
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			return "", false
		}
		a, ok1 := constant(v.X, consts)
		b, ok2 := constant(v.Y, consts)
		return a + b, ok1 && ok2
	}
	return "", false
}

// file collects the messages of one file.
// own is true for core/i18n's own files, where the calls have no package name and a call whose
// message is a parameter only passes it on.
func (x *extraction) file(fset *token.FileSet, f *ast.File, rel string, consts map[string]string, own bool) {
	// The names that this file gives the two packages.
	names := map[string]string{}
	for _, imp := range f.Imports {
		path, _ := strconv.Unquote(imp.Path.Value)
		if _, ok := calls[path]; !ok {
			continue
		}
		// The errors of the agents' tools are read by a model, in English (core/agents). Only
		// what that package says to the user, with core/i18n, is translated.
		if path == errsPath && strings.HasPrefix(rel, "core/agents/") {
			continue
		}
		name := filepath.Base(path)
		if imp.Name != nil {
			name = imp.Name.Name
		}
		names[name] = path
	}
	if len(names) == 0 && !own {
		return
	}
	// A comment that starts with "i18n:" on the line above a call is a note for the translator.
	// It belongs to the first message on that line, so a line with two messages needs the
	// second one on a line of its own to have a note.
	notes := map[int]string{}
	noted := map[int]bool{}
	for _, group := range f.Comments {
		text := strings.TrimSpace(group.Text())
		if note, ok := strings.CutPrefix(text, "i18n:"); ok {
			notes[fset.Position(group.End()).Line] = strings.Join(strings.Fields(note), " ")
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		c, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		var spec call
		var fn string
		switch fun := c.Fun.(type) {
		case *ast.SelectorExpr:
			pkg, ok := fun.X.(*ast.Ident)
			if !ok {
				return true
			}
			if spec, ok = calls[names[pkg.Name]][fun.Sel.Name]; !ok {
				return true
			}
			fn = pkg.Name + "." + fun.Sel.Name
		case *ast.Ident:
			if !own {
				return true
			}
			if spec, ok = calls[i18nPath][fun.Name]; !ok {
				return true
			}
			fn = fun.Name
		default:
			return true
		}
		pos := fset.Position(c.Pos())
		where := fmt.Sprintf("%s:%d", rel, pos.Line)
		if len(c.Args) <= spec.format || spec.ctx >= len(c.Args) {
			return true
		}
		id, ok := constant(c.Args[spec.format], consts)
		if !ok {
			if !own {
				x.problems = append(x.problems, where+": the message of "+fn+" is not a string constant, so it can't be translated")
			}
			return true
		}
		ctx := ""
		if spec.ctx >= 0 {
			if ctx, ok = constant(c.Args[spec.ctx], consts); !ok {
				x.problems = append(x.problems, where+": the context of "+fn+" is not a string constant")
				return true
			}
		}
		if strings.TrimSpace(strings.NewReplacer("%s", "", "%v", "", "%w", "").Replace(id)) == "" {
			x.problems = append(x.problems, where+": the message of "+fn+" is only its value ("+strconv.Quote(id)+"), so it can't be translated")
			return true
		}
		plural := ""
		if spec.plural >= 0 {
			if len(c.Args) <= spec.plural {
				return true
			}
			if plural, ok = constant(c.Args[spec.plural], consts); !ok {
				x.problems = append(x.problems, where+": the plural message of "+fn+" is not a string constant")
				return true
			}
		}
		key := ctx + "\x04" + id
		m := x.messages[key]
		if m == nil {
			m = &message{ctx: ctx, id: id, plural: plural, files: map[string]bool{}}
			x.messages[key] = m
		}
		if m.plural != plural {
			x.problems = append(x.problems, where+": "+strconv.Quote(id)+" is used with two different plurals")
		}
		m.files[rel] = true
		if note := notes[pos.Line-1]; note != "" && !noted[pos.Line] {
			noted[pos.Line] = true
			if !contains(m.notes, note) {
				m.notes = append(m.notes, note)
			}
		}
		return true
	})
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// readFile returns a file's text, or "" when it doesn't exist.
func readFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return "", nil
	}
	return string(b), err
}
