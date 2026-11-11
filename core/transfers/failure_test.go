package transfers

import "testing"

func TestFailureText(t *testing.T) {
	const ssh = "couldn't connect SSH: connection refused"
	const file = "couldn't copy from a.txt: permission denied"
	for _, c := range []struct {
		err, general string
		files        int
		fileErr      string
		want         string
	}{
		{"1 of 1 operations failed", ssh, 0, "", ssh},
		{"2 of 3 operations failed", ssh, 0, "", "2 of 3 operations failed: " + ssh},
		// The step's own error comes before the files'.
		{"1 of 1 operations failed", ssh, 1, file, ssh},
		{"1 of 1 operations failed", "", 1, file, "1 file failed: " + file},
		{"1 of 1 operations failed", "", 3, file, "3 files failed. The first error: " + file},
		{"2 of 2 operations failed", "", 1000, file, "2 of 2 operations failed: at least 1000 files failed. The first error: " + file},
		// Nothing more to say: the count alone.
		{"1 of 2 operations failed", "", 0, "", "1 of 2 operations failed"},
		{"2 of 3 operations failed", "2 of 3 operations failed", 0, "", "2 of 3 operations failed"},
		// An error of its own is kept as it is.
		{"directory not found", ssh, 1, file, "directory not found"},
	} {
		if got := failureText(words(c.err), words(c.general), c.files, c.fileErr).String(); got != c.want {
			t.Errorf("failureText(%q, %q, %d) = %q, want %q", c.err, c.general, c.files, got, c.want)
		}
	}
}

// TestFailureTextReadsTheFiles: a transfer whose files failed gets the first one's error.
func TestFailureTextReadsTheFiles(t *testing.T) {
	f := newFixture(t)
	f.seed("100-a", 100, map[string]any{"state": "failed", "error": "1 of 1 operations failed"})
	for i, name := range []string{"b.txt", "a.txt"} {
		f.exec(`INSERT INTO transfer_files (transfer_id, outcome, src_fs, name, error, completed_ms)
			VALUES ('100-a', 'failed', '/src', ?, ?, ?)`, name, "couldn't copy "+name+": permission denied", 200+i)
	}
	tr := f.get("100-a")
	if got := f.s.FailureText(f.ctx, tr).String(); got != "2 files failed. The first error: couldn't copy b.txt: permission denied" {
		t.Errorf("FailureText = %q", got)
	}
	f.seed("100-b", 101, map[string]any{"state": "failed", "error": "directory not found"})
	if got := f.s.FailureText(f.ctx, f.get("100-b")).String(); got != "directory not found" {
		t.Errorf("an error of its own: %q", got)
	}
}
