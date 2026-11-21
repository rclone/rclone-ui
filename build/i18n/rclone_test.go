package main

import (
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func k(parts ...string) string { return strings.Join(parts, sep) }

func fixture() map[string]map[string]string {
	return map[string]map[string]string{
		"en": {
			k("backend", "local", "description"):                           "Local Disk",
			k("backend", "local", "option", "nounc", "help"):               "Disable UNC (long path names) conversion on Windows.",
			k("backend", "s3", "option", "acl", "provider", "AWS", "help"): "Canned ACL.",
			k("options", "main", "option", "transfers", "help"):            "Number of file transfers to run in parallel",
		},
		"es": {
			k("backend", "local", "description"):                           "Disco local",
			k("backend", "local", "option", "nounc", "help"):               "Desactiva la conversión UNC en Windows.",
			k("backend", "s3", "option", "acl", "provider", "AWS", "help"): "ACL predefinida.",
			k("options", "main", "option", "transfers", "help"):            "Número de transferencias en paralelo",
			k("options", "main", "option", "gone", "help"):                 "Una opción que ya no existe",
		},
	}
}

// live is what the rclone on this system gives: it lacks nounc (a Windows option), has a new
// option, a changed text, and the ACL help under a longer provider list.
func live() map[string]string {
	return map[string]string{
		k("backend", "local", "description"):                                "Local Disk",
		k("backend", "s3", "option", "acl", "provider", "AWS,Ceph", "help"): "Canned ACL.",
		k("options", "main", "option", "transfers", "help"):                 "Number of file transfers to run in parallel.",
		k("options", "main", "option", "checkers", "help"):                  "Number of checkers to run in parallel",
	}
}

func TestMergeRcloneKeepsWhatThisSystemLacks(t *testing.T) {
	files := fixture()
	mergeRclone(live(), files, false)
	en, es := files["en"], files["es"]

	if en[k("options", "main", "option", "checkers", "help")] != "Number of checkers to run in parallel" {
		t.Error("a new key isn't added to en")
	}
	if en[k("options", "main", "option", "transfers", "help")] != "Number of file transfers to run in parallel." {
		t.Error("a changed English text isn't updated")
	}
	if _, ok := es[k("options", "main", "option", "transfers", "help")]; ok {
		t.Error("the translation of a changed English text is kept")
	}
	if _, ok := en[k("backend", "local", "option", "nounc", "help")]; !ok {
		t.Error("a key that this system's rclone lacks is dropped without -prune")
	}
	if es[k("backend", "local", "option", "nounc", "help")] == "" {
		t.Error("the translation of a key that this system's rclone lacks is dropped without -prune")
	}
	if es[k("backend", "local", "description")] != "Disco local" {
		t.Error("an unchanged translation is lost")
	}
	if got := es[k("backend", "s3", "option", "acl", "provider", "AWS,Ceph", "help")]; got != "ACL predefinida." {
		t.Errorf("a new key with an existing text of the same backend got %q, want the existing translation", got)
	}
	if _, ok := es[k("options", "main", "option", "checkers", "help")]; ok {
		t.Error("a new key got a translation")
	}
	if _, ok := es[k("options", "main", "option", "gone", "help")]; !ok {
		t.Error("a language's key that en lacks is dropped without -prune")
	}
}

func TestMergeRclonePrune(t *testing.T) {
	files := fixture()
	mergeRclone(live(), files, true)
	for lang, f := range files {
		if _, ok := f[k("backend", "local", "option", "nounc", "help")]; ok {
			t.Errorf("%s: -prune keeps a key that rclone lacks", lang)
		}
		if _, ok := f[k("options", "main", "option", "gone", "help")]; ok {
			t.Errorf("%s: -prune keeps a key that en lacks", lang)
		}
	}
	if len(files["en"]) != len(live()) {
		t.Errorf("en has %d keys after -prune, want rclone's %d", len(files["en"]), len(live()))
	}
}

func TestRcloneFilesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "locales", "es", rcloneFile)
	want := fixture()["es"]
	want[k("backend", "s3", "option", "region", "example", "__empty__", "help")] = "Usa <esto> & aquello"
	if err := writeTexts(path, want); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"description": "Disco local"`) || !strings.Contains(string(b), "<esto> & aquello") {
		t.Errorf("the file isn't a readable tree:\n%s", b)
	}
	got, err := readTexts(path)
	if err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(got, want) {
		t.Errorf("read back %v, want %v", got, want)
	}
}

func TestReviewRcloneWarns(t *testing.T) {
	dir := t.TempDir()
	files := fixture()
	for lang, f := range files {
		if err := writeTexts(filepath.Join(dir, "locales", lang, rcloneFile), f); err != nil {
			t.Fatal(err)
		}
	}
	delete(files["es"], k("backend", "local", "description"))
	if err := writeTexts(filepath.Join(dir, "locales", "es", rcloneFile), files["es"]); err != nil {
		t.Fatal(err)
	}
	problems, warnings, err := reviewRclone(dir, []string{"en", "es", "zh-CN"})
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) > 0 {
		t.Errorf("problems in files without setup questions: %q", problems)
	}
	joined := strings.Join(warnings, "\n")
	for _, want := range []string{
		"locales/es/rclone.json: no translation for 1 of rclone's 4 texts",
		"locales/es/rclone.json: keys that en/rclone.json no longer has: 1",
		"locales/zh-CN/rclone.json: no translation for 4 of rclone's 4 texts",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("the warnings lack %q:\n%s", want, joined)
		}
	}
}
