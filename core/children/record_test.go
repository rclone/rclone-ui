package children

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRecordsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := []Record{{ID: "0000abcd", Kind: KindMount, Name: "gdrive:", Args: []string{"mount"}, Restore: true}}
	if err := writeRecords(dir, want); err != nil {
		t.Fatal(err)
	}
	got, err := readRecords(dir)
	if err != nil || len(got) != 1 || got[0].ID != want[0].ID || !got[0].Restore {
		t.Fatalf("read %+v, %v; want %+v", got, err, want)
	}
}

// TestRecordsOfAnotherVersionAreRefused checks that a children.json in a version that this build
// doesn't know is an error, so leftovers are not killed on a guess.
func TestRecordsOfAnotherVersionAreRefused(t *testing.T) {
	dir := t.TempDir()
	doc := `{"version": 2, "children": [{"id": "0000abcd", "kind": "mount", "pid": 1}]}`
	if err := os.WriteFile(filepath.Join(dir, recordsFile), []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if recs, err := readRecords(dir); err == nil {
		t.Fatalf("read %+v from a version 2 file", recs)
	}
}
