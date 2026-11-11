package transfers

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// jobPaths are the rc paths for transfer jobs and stats that only this package may call. In any
// other package, a call by a group's name could create the group again after the transfer ended.
// This package doesn't call them either. It reads a transfer's group through its *StatsInfo,
// and stops its job through its *jobs.Job.
var jobPaths = map[string]bool{
	"core/stats": true, "core/transferred": true, "job/status": true, "job/stop": true,
	"job/stopgroup": true, "job/list": true,
}

// TestOnlyTransfersCallsJobPaths searches the module's Go files for those rc paths as string
// literals. None may appear outside core/transfers, and core/transferred may not appear at all,
// because the ledger reads a group's finished files through its *StatsInfo. core/children is
// exempt, because it calls a child process's own rc over its socket, never this process's
// stats groups.
func TestOnlyTransfersCallsJobPaths(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	own := filepath.Join(root, "core", "transfers")
	children := filepath.Join(root, "core", "children")
	fset := token.NewFileSet()
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "dist" || name == "testdata") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return nil // a file that is being edited elsewhere: not this test's concern
		}
		if filepath.Dir(path) == children {
			return nil
		}
		inOwn := filepath.Dir(path) == own
		ast.Inspect(file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			s, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			p := strings.TrimPrefix(s, "/")
			switch {
			case !jobPaths[p]:
			case !inOwn:
				t.Errorf("%s: %q is core/transfers' alone", fset.Position(lit.Pos()), s)
			case p == "core/transferred" && !strings.HasSuffix(path, "_test.go"):
				t.Errorf("%s: core/transferred is read through the group's pointer", fset.Position(lit.Pos()))
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
