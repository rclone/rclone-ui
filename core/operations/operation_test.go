package operations

import (
	"encoding/json"
	"slices"
	"testing"
)

// The sources and destination shown on a transfer, read from each operation's form.
// No remote has a one-letter name, because Windows reads `a:x` as a path on drive A.
func TestEnds(t *testing.T) {
	for _, tc := range []struct {
		op, args string
		sources  []string
		dest     string
	}{
		{"copy", `{"sources":["one:x","two:y"],"destination":"three:"}`, []string{"one:x", "two:y"}, "three:"},
		{"move", `{"sources":["one:x"],"destination":"three:"}`, []string{"one:x"}, "three:"},
		{"sync", `{"source":"one:x","destination":"three:z"}`, []string{"one:x"}, "three:z"},
		{"bisync", `{"source":"one:x","destination":"three:z"}`, []string{"one:x"}, "three:z"},
		{"delete", `{"sources":["one:x"]}`, []string{"one:x"}, ""},
		{"purge", `{"sources":["one:x"]}`, []string{"one:x"}, ""},
		{"download", `{"url":"https://e/x.zip","filename":"x.zip","destination":"gdrive:dl"}`, []string{"https://e/x.zip"}, "gdrive:dl/x.zip"},
		{"save", `{"source":"one:f.txt","destination":"/srv/f.txt"}`, []string{"one:f.txt"}, "/srv/f.txt"},
		{"rename", `{"items":[{"path":"one:d/old","isDir":true,"newName":"new"}]}`, []string{"one:d/old"}, "one:d/new"},
		{"rename", `{"items":[{"path":"sftp:/d/old/","isDir":true,"newName":"new"}]}`, []string{"sftp:/d/old/"}, "sftp:/d/new"},
		{"rename", `{"items":[{"path":"one:x","newName":"y"},{"path":"one:z","newName":"w"}]}`, []string{"one:x", "one:z"}, ""},
		{"delete-folder", `{"path":"/srv/old"}`, []string{"/srv/old"}, ""},
		{"cleanup", `{"remote":"gdrive:"}`, []string{"gdrive:"}, ""},
		{"mount", `{"source":"one:x","destination":"/mnt/x"}`, []string{"one:x"}, "/mnt/x"},
		{"serve", `{"type":"http","source":"one:x"}`, []string{"one:x"}, ""},
	} {
		f, err := DecodeForm(Operation(tc.op), json.RawMessage(tc.args))
		if err != nil {
			t.Errorf("%s %s: %v", tc.op, tc.args, err)
			continue
		}
		sources, dest := f.Ends()
		if !slices.Equal(sources, tc.sources) || dest != tc.dest {
			t.Errorf("%s %s: %v %q, want %v %q", tc.op, tc.args, sources, dest, tc.sources, tc.dest)
		}
	}
}

// Every operation is registered once with what BuildPlan needs, and each transfer is recorded as
// one of the operations that a transfer row can show.
func TestOperationSpecs(t *testing.T) {
	var recorded []Operation
	for name, spec := range operationSpecs {
		if spec.build == nil {
			t.Errorf("%s: no build", name)
		}
		if _, ok := slotFor(name); !ok {
			t.Errorf("%s: no field in Form", name)
		}
		if spec.describe && spec.settings == nil {
			t.Errorf("%s: described without the settings its plan runs with", name)
		}
		if IsRecordedOperation(RecordedOperation(name)) {
			recorded = append(recorded, RecordedOperation(name))
		} else {
			t.Errorf("%s is recorded as %s, which no row may be", name, RecordedOperation(name))
		}
	}
	slices.Sort(recorded)
	want := []Operation{"bisync", "cleanup", "copy", "delete", "download", "move", "purge", "sync"}
	if got := slices.Compact(recorded); !slices.Equal(got, want) {
		t.Errorf("recorded as %v, want %v", got, want)
	}
	for _, op := range []Operation{"", OperationSave, OperationRename, OperationDeleteFolder, OperationMount, "format"} {
		if IsRecordedOperation(op) {
			t.Errorf("a row may be recorded as %q", op)
		}
	}
	if RecordedOperation(OperationRename) != "move" || RecordedOperation(OperationDeleteFolder) != "purge" ||
		RecordedOperation(OperationSave) != "download" || RecordedOperation("copy") != "copy" {
		t.Error("recorded operations")
	}
}
