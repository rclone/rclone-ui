package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const rcloneModule = "github.com/rclone/rclone"

var commonSetup = []string{"fs", "lib/oauthutil"}

type setupCall struct{ name, help, items int }

var setupCalls = map[string]setupCall{
	"ConfigConfirm":              {2, 3, -1},
	"ConfigInput":                {1, 2, -1},
	"ConfigInputOptional":        {1, 2, -1},
	"ConfigPassword":             {1, 2, -1},
	"ConfigChoose":               {1, 2, -1},
	"ConfigChooseExclusive":      {1, 2, -1},
	"ConfigChooseFixed":          {1, 2, 3},
	"ConfigChooseExclusiveFixed": {1, 2, 3},
	"ConfigError":                {-1, 1, -1},
}

type setupTexts struct {
	questions    map[string][]string
	choices      map[string]map[string]string
	errors       []string
	asked, shown int
}

type setupSource struct {
	scopes map[string]*setupTexts
	unread []string
}

func rcloneSource(dir string) (string, error) {
	cmd := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", rcloneModule)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOPROXY=off", "GOFLAGS=-mod=readonly")
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("go list -m %s: %w", rcloneModule, err)
	}
	src := strings.TrimSpace(string(out))
	if src == "" {
		return "", fmt.Errorf("rclone's source isn't in the module cache: run go mod download %s", rcloneModule)
	}
	return src, nil
}

func collectSetup(root string) (*setupSource, error) {
	r := &sourceReader{root: root, fset: token.NewFileSet(), pkgs: map[string]*sourcePkg{}}
	out := &setupSource{scopes: map[string]*setupTexts{}}
	folders := slices.Clone(commonSetup)
	entries, err := os.ReadDir(filepath.Join(root, "backend"))
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() {
			folders = append(folders, "backend/"+e.Name())
		}
	}
	for _, folder := range folders {
		p, err := r.pkg(folder)
		if err != nil {
			return nil, err
		}
		if p == nil {
			continue
		}
		scope := ""
		if strings.HasPrefix(folder, "backend/") {
			names := p.registered(r)
			if len(names) != 1 {
				if p.asks() {
					out.unread = append(out.unread, fmt.Sprintf("%s: the backend's name can't be read (%d names found), so its questions are skipped", folder, len(names)))
				}
				continue
			}
			scope = names[0]
		}
		st := out.scopes[scope]
		if st == nil {
			st = &setupTexts{questions: map[string][]string{}, choices: map[string]map[string]string{}}
		}
		out.unread = append(out.unread, p.collect(r, st)...)
		if st.asked > 0 || st.shown > 0 {
			out.scopes[scope] = st
		}
	}
	return out, nil
}

func (s *setupSource) keys() map[string]string {
	out := map[string]string{}
	for scope, st := range s.scopes {
		prefix := []string{"setup"}
		if scope != "" {
			prefix = append(prefix, "backend", scope)
		}
		at := func(parts ...string) string { return strings.Join(append(slices.Clone(prefix), parts...), sep) }
		for name, helps := range st.questions {
			for i, h := range helps {
				out[at("question", name, variant(i))] = h
			}
		}
		for name, choices := range st.choices {
			for value, h := range choices {
				out[at("question", name, "example", valueKey(value), "help")] = h
			}
		}
		for i, e := range st.errors {
			out[at("error", variant(i))] = e
		}
	}
	return out
}

func (s *setupSource) report() string {
	questions, texts, choices, errors, backends := 0, 0, 0, 0, 0
	for scope, st := range s.scopes {
		if scope != "" {
			backends++
		}
		questions += st.asked
		for _, helps := range st.questions {
			texts += len(helps)
		}
		for _, c := range st.choices {
			choices += len(c)
		}
		errors += len(st.errors)
	}
	return fmt.Sprintf("rclone's setup questions, from its source: %d questions with %d texts, %d fixed choices and %d errors, from %d backends and the common config, and %d that can't be read",
		questions, texts, choices, errors, backends, len(s.unread))
}

func variant(i int) string {
	if i == 0 {
		return "help"
	}
	return fmt.Sprintf("help_%d", i+1)
}

func valueKey(v string) string {
	if v == "" {
		return "__empty__"
	}
	return v
}

type sourceReader struct {
	root string
	fset *token.FileSet
	pkgs map[string]*sourcePkg
}

type sourcePkg struct {
	folder string
	files  []*ast.File
	paths  []string
	consts map[string]*sourceConst
}

type sourceConst struct {
	expr    ast.Expr
	file    *ast.File
	value   setupValue
	ok      bool
	reading bool
	read    bool
}

func (r *sourceReader) pkg(folder string) (*sourcePkg, error) {
	if p, ok := r.pkgs[folder]; ok {
		return p, nil
	}
	entries, err := os.ReadDir(filepath.Join(r.root, filepath.FromSlash(folder)))
	if err != nil {
		if os.IsNotExist(err) {
			r.pkgs[folder] = nil
			return nil, nil
		}
		return nil, err
	}
	p := &sourcePkg{folder: folder, consts: map[string]*sourceConst{}}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(r.fset, filepath.Join(r.root, filepath.FromSlash(folder), name), nil, parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		p.files = append(p.files, f)
		p.paths = append(p.paths, folder+"/"+name)
		for _, d := range f.Decls {
			g, ok := d.(*ast.GenDecl)
			if !ok || g.Tok != token.CONST {
				continue
			}
			for _, spec := range g.Specs {
				v := spec.(*ast.ValueSpec)
				for i, id := range v.Names {
					if i < len(v.Values) {
						p.consts[id.Name] = &sourceConst{expr: v.Values[i], file: f}
					}
				}
			}
		}
	}
	if len(p.files) == 0 {
		p = nil
	}
	r.pkgs[folder] = p
	return p, nil
}

func imports(f *ast.File) map[string]string {
	out := map[string]string{}
	for _, imp := range f.Imports {
		path, _ := strconv.Unquote(imp.Path.Value)
		name := filepath.Base(path)
		if imp.Name != nil {
			name = imp.Name.Name
		}
		out[name] = path
	}
	return out
}

func helper(c *ast.CallExpr, fsName string, inFs bool) (string, bool) {
	var name string
	switch fun := c.Fun.(type) {
	case *ast.SelectorExpr:
		x, ok := fun.X.(*ast.Ident)
		if !ok || inFs || fsName == "" || x.Name != fsName {
			return "", false
		}
		name = fun.Sel.Name
	case *ast.Ident:
		if !inFs {
			return "", false
		}
		name = fun.Name
	default:
		return "", false
	}
	_, ok := setupCalls[name]
	return name, ok
}

func (p *sourcePkg) registered(r *sourceReader) []string {
	var names []string
	for _, f := range p.files {
		fsName := fsImport(f)
		ast.Inspect(f, func(n ast.Node) bool {
			lit, ok := n.(*ast.CompositeLit)
			if !ok {
				return true
			}
			sel, ok := lit.Type.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "RegInfo" {
				return true
			}
			if x, ok := sel.X.(*ast.Ident); !ok || x.Name != fsName {
				return true
			}
			for _, e := range lit.Elts {
				kv, ok := e.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				if id, ok := kv.Key.(*ast.Ident); !ok || id.Name != "Name" {
					continue
				}
				if v, ok := r.read(p, &site{file: f}, kv.Value); ok && !v.format && !slices.Contains(names, v.text) {
					names = append(names, v.text)
				}
			}
			return true
		})
	}
	return names
}

func (p *sourcePkg) asks() bool {
	found := false
	for _, f := range p.files {
		fsName := fsImport(f)
		ast.Inspect(f, func(n ast.Node) bool {
			if c, ok := n.(*ast.CallExpr); ok {
				if _, ok := helper(c, fsName, p.folder == "fs"); ok {
					found = true
				}
			}
			return !found
		})
	}
	return found
}

func fsImport(f *ast.File) string {
	for name, path := range imports(f) {
		if path == rcloneModule+"/fs" {
			return name
		}
	}
	return ""
}

func (p *sourcePkg) collect(r *sourceReader, st *setupTexts) []string {
	var unread []string
	for i, f := range p.files {
		fsName := fsImport(f)
		if fsName == "" && p.folder != "fs" {
			continue
		}
		var stack []ast.Node
		ast.Inspect(f, func(n ast.Node) bool {
			if n == nil {
				stack = stack[:len(stack)-1]
				return false
			}
			stack = append(stack, n)
			c, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			name, ok := helper(c, fsName, p.folder == "fs")
			if !ok {
				return true
			}
			at := &site{file: f, stack: stack, pos: c.Pos()}
			where := fmt.Sprintf("%s:%d", p.paths[i], r.fset.Position(c.Pos()).Line)
			if problem := p.call(r, st, at, name, c); problem != "" {
				unread = append(unread, where+": "+problem)
			}
			return true
		})
	}
	return unread
}

func (p *sourcePkg) call(r *sourceReader, st *setupTexts, at *site, fn string, c *ast.CallExpr) string {
	spec := setupCalls[fn]
	if len(c.Args) <= max(spec.name, spec.help, spec.items) {
		return ""
	}
	if spec.name >= 0 && at.param(c.Args[spec.name]) || at.param(c.Args[spec.help]) {
		return ""
	}
	name := ""
	if spec.name >= 0 {
		v, ok := r.read(p, at, c.Args[spec.name])
		if !ok || v.format {
			return "the name of a question (" + fn + ") can't be read: " + types.ExprString(c.Args[spec.name])
		}
		name = v.text
	}
	what := "the error"
	if name != "" {
		what = "the help of " + name
	}
	v, ok := r.read(p, at, c.Args[spec.help])
	if !ok {
		return what + " can't be read: " + types.ExprString(c.Args[spec.help])
	}
	format := v.text
	if !v.format {
		format = strings.ReplaceAll(v.text, "%", "%%")
	}
	if strings.TrimSpace(format) == "" {
		return ""
	}
	if bad := unmatchable(format); bad != "" {
		return what + " can't be matched: " + bad
	}
	if name == "" {
		st.shown++
		if !slices.Contains(st.errors, format) {
			st.errors = append(st.errors, format)
		}
		return ""
	}
	st.asked++
	if !slices.Contains(st.questions[name], format) {
		st.questions[name] = append(st.questions[name], format)
	}
	if spec.items >= 0 {
		return p.choices(r, st, at, name, c.Args[spec.items])
	}
	return ""
}

func (p *sourcePkg) choices(r *sourceReader, st *setupTexts, at *site, name string, items ast.Expr) string {
	lit, ok := items.(*ast.CompositeLit)
	if !ok {
		return "the choices of " + name + " can't be read, because they are made at run time: " + types.ExprString(items)
	}
	for _, e := range lit.Elts {
		item, ok := e.(*ast.CompositeLit)
		if !ok {
			return "a choice of " + name + " can't be read: " + types.ExprString(e)
		}
		var value, help *setupValue
		for _, f := range item.Elts {
			kv, ok := f.(*ast.KeyValueExpr)
			if !ok {
				return "a choice of " + name + " can't be read: " + types.ExprString(item)
			}
			id, _ := kv.Key.(*ast.Ident)
			if id == nil || id.Name != "Value" && id.Name != "Help" {
				continue
			}
			v, ok := r.read(p, at, kv.Value)
			if !ok || v.format {
				return "a choice of " + name + " can't be read: " + types.ExprString(kv.Value)
			}
			if id.Name == "Value" {
				value = &v
			} else {
				help = &v
			}
		}
		if value == nil || help == nil || help.text == "" {
			continue
		}
		if st.choices[name] == nil {
			st.choices[name] = map[string]string{}
		}
		if old, ok := st.choices[name][value.text]; ok && old != help.text {
			return fmt.Sprintf("the choice %q of %s has two helps, so the second is skipped", value.text, name)
		}
		st.choices[name][value.text] = help.text
	}
	return ""
}

var (
	anyVerb   = regexp.MustCompile(`%[^%a-zA-Z]*[a-zA-Z%]`)
	plainVerb = regexp.MustCompile(`^%[qsvd%]$`)
)

func unmatchable(format string) string {
	for _, v := range anyVerb.FindAllString(format, -1) {
		if !plainVerb.MatchString(v) {
			return "it uses " + v
		}
	}
	if strings.TrimSpace(anyVerb.ReplaceAllString(format, "")) == "" {
		return "it is only its values: " + strconv.Quote(format)
	}
	return ""
}

type setupValue struct {
	text   string
	format bool
}

type site struct {
	file  *ast.File
	stack []ast.Node
	pos   token.Pos
}

func (s *site) fn() int {
	for i := len(s.stack) - 1; i >= 0; i-- {
		switch s.stack[i].(type) {
		case *ast.FuncLit, *ast.FuncDecl:
			return i
		}
	}
	return -1
}

func funcParts(n ast.Node) (*ast.FuncType, *ast.BlockStmt) {
	switch f := n.(type) {
	case *ast.FuncLit:
		return f.Type, f.Body
	case *ast.FuncDecl:
		return f.Type, f.Body
	}
	return nil, nil
}

func (s *site) param(e ast.Expr) bool {
	id, ok := e.(*ast.Ident)
	i := s.fn()
	if !ok || i < 0 {
		return false
	}
	typ, _ := funcParts(s.stack[i])
	if typ.Params == nil {
		return false
	}
	for _, field := range typ.Params.List {
		for _, n := range field.Names {
			if n.Name == id.Name {
				return true
			}
		}
	}
	return false
}

func (s *site) assigned(name string) (ast.Expr, *site, bool) {
	fi := s.fn()
	if fi < 0 {
		return nil, nil, false
	}
	_, body := funcParts(s.stack[fi])
	if body == nil {
		return nil, nil, false
	}
	var value ast.Expr
	var from *site
	var stack []ast.Node
	ast.Inspect(body, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return false
		}
		if n.Pos() >= s.pos {
			return false
		}
		if _, ok := n.(*ast.FuncLit); ok {
			return false
		}
		stack = append(stack, n)
		var lhs, rhs []ast.Expr
		switch a := n.(type) {
		case *ast.AssignStmt:
			if a.Tok != token.ASSIGN && a.Tok != token.DEFINE || a.End() > s.pos {
				return true
			}
			lhs, rhs = a.Lhs, a.Rhs
		case *ast.ValueSpec:
			if a.End() > s.pos {
				return true
			}
			for _, id := range a.Names {
				lhs = append(lhs, id)
			}
			rhs = a.Values
		default:
			return true
		}
		for i, l := range lhs {
			if id, ok := l.(*ast.Ident); !ok || id.Name != name {
				continue
			}
			value, from = nil, nil
			if len(rhs) == len(lhs) && s.inBlockOf(stack) {
				value = rhs[i]
				from = &site{file: s.file, stack: append(slices.Clone(s.stack[:fi+1]), stack...), pos: n.Pos()}
			}
		}
		return true
	})
	return value, from, value != nil
}

func (s *site) inBlockOf(stack []ast.Node) bool {
	for i := len(stack) - 1; i >= 0; i-- {
		switch b := stack[i].(type) {
		case *ast.BlockStmt, *ast.CaseClause, *ast.CommClause:
			return b.Pos() <= s.pos && s.pos < b.End()
		}
	}
	return true
}

func (r *sourceReader) read(p *sourcePkg, at *site, e ast.Expr) (setupValue, bool) {
	return r.readDepth(p, at, e, 0)
}

func (r *sourceReader) readDepth(p *sourcePkg, at *site, e ast.Expr, depth int) (setupValue, bool) {
	if depth > 20 {
		return setupValue{}, false
	}
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind != token.STRING {
			return setupValue{}, false
		}
		s, err := strconv.Unquote(v.Value)
		return setupValue{text: s}, err == nil
	case *ast.ParenExpr:
		return r.readDepth(p, at, v.X, depth+1)
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			return setupValue{}, false
		}
		a, ok1 := r.readDepth(p, at, v.X, depth+1)
		b, ok2 := r.readDepth(p, at, v.Y, depth+1)
		if !ok1 || !ok2 || a.format || b.format {
			return setupValue{}, false
		}
		return setupValue{text: a.text + b.text}, true
	case *ast.Ident:
		if at != nil && at.stack != nil {
			if value, from, ok := at.assigned(v.Name); ok {
				return r.readDepth(p, from, value, depth+1)
			}
			if at.param(v) {
				return setupValue{}, false
			}
		}
		return r.constant(p, v.Name)
	case *ast.SelectorExpr:
		x, ok := v.X.(*ast.Ident)
		if !ok || at == nil {
			return setupValue{}, false
		}
		path, ok := imports(at.file)[x.Name]
		folder, inModule := strings.CutPrefix(path, rcloneModule+"/")
		if !ok || !inModule {
			return setupValue{}, false
		}
		other, err := r.pkg(folder)
		if err != nil || other == nil {
			return setupValue{}, false
		}
		return r.constant(other, v.Sel.Name)
	case *ast.CallExpr:
		sel, ok := v.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "Sprintf" || len(v.Args) == 0 || at == nil {
			return setupValue{}, false
		}
		if x, ok := sel.X.(*ast.Ident); !ok || imports(at.file)[x.Name] != "fmt" {
			return setupValue{}, false
		}
		f, ok := r.readDepth(p, at, v.Args[0], depth+1)
		if !ok || f.format {
			return setupValue{}, false
		}
		return setupValue{text: f.text, format: true}, true
	}
	return setupValue{}, false
}

func (r *sourceReader) constant(p *sourcePkg, name string) (setupValue, bool) {
	c := p.consts[name]
	if c == nil || c.reading {
		return setupValue{}, false
	}
	if !c.read {
		c.reading = true
		c.value, c.ok = r.read(p, &site{file: c.file}, c.expr)
		c.reading, c.read = false, true
	}
	return c.value, c.ok
}
