package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRunSkipsDotfiles(t *testing.T) {
	src := t.TempDir()
	dst := filepath.Join(t.TempDir(), "dist")
	files := map[string]string{
		"index.html": "<!doctype html>" + strings.Repeat("<p>page</p>", 100),
		".DS_Store":  "Finder's",
		".x/y":       "hidden",
	}
	for name, body := range files {
		p := filepath.Join(src, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := run(src, dst); err != nil {
		t.Fatal(err)
	}
	var got []string
	err := filepath.WalkDir(dst, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dst, p)
		got = append(got, filepath.ToSlash(rel))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []string{"index.html.zst"}) {
		t.Fatalf("embedded %v, want only index.html.zst", got)
	}
}
