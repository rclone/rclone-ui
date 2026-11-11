package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/app/update"
)

func writeFiles(t *testing.T, dir string, names []string) []string {
	t.Helper()
	paths := make([]string, 0, len(names))
	for i, n := range names {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte(strings.Repeat(n, 1000+i)), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
	}
	return paths
}

func updateNames(version string) []string {
	var names []string
	for n := range updateFiles(version) {
		names = append(names, n)
	}
	slices.Sort(names)
	return names
}

func policyFile(t *testing.T, text string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestManifest(t *testing.T) {
	dir := t.TempDir()
	if paths := writeFiles(t, dir, updateNames("4.0.0")); len(paths) != 10 {
		t.Fatalf("%d files in the table, want 10", len(paths))
	}

	policy := policyFile(t, `{"minimum": "4.0.0", "recommended": "4.0.1"}`)
	if err := manifest([]string{"-version", "v4.0.0", "-base-url", "https://example.com/v4.0.0/", "-policy", policy, "-rclone", "v1.75.1", dir}); err != nil {
		t.Fatal(err)
	}
	raw := []byte(mustRead(t, filepath.Join(dir, update.FeedName)))
	var f update.Feed
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.Format != update.FeedFormat || f.Release.Version != "4.0.0" || f.Release.Date == "" || f.Rclone != "v1.75.1" ||
		f.Policy != (update.Policy{Minimum: "4.0.0", Recommended: "4.0.1"}) {
		t.Fatalf("feed %+v", f)
	}
	if len(f.Files) != 10 {
		t.Fatalf("%d files in the feed, want 10: %v", len(f.Files), f.Files)
	}
	for name, a := range updateFiles("4.0.0") {
		p, ok := f.Files[update.FileKey(a.goos, a.goarch, a.kind)]
		if !ok || p.URL != "https://example.com/v4.0.0/"+name {
			t.Fatalf("%s: %+v", name, p)
		}
	}
	if tauriUpdaterReads(t, raw) {
		t.Error("the Tauri updater would read the feed")
	}
}

// tauriUpdaterReads reports whether the Tauri app's updater could take b for a release. Its
// tauri-plugin-updater (2.9.0 in v1.3.0 to v3.5.4, 2.10.1 in v3.7.5) reads a release with
// RemoteRelease's Deserialize (src/updater.rs): it needs a top-level "version" (or "name"), and
// either "platforms", or "url" and "signature".
func tauriUpdaterReads(t *testing.T, b []byte) bool {
	t.Helper()
	var top map[string]json.RawMessage
	if err := json.Unmarshal(b, &top); err != nil {
		t.Fatal(err)
	}
	has := func(k string) bool { _, ok := top[k]; return ok }
	if !has("version") && !has("name") {
		return false
	}
	return has("platforms") || has("url") && has("signature")
}

// TestTauriUpdaterRule checks that tauriUpdaterReads accepts a feed in the Tauri app's own format.
// Without that, its check in TestManifest could never fail.
func TestTauriUpdaterRule(t *testing.T) {
	for _, c := range []struct {
		feed  string
		reads bool
	}{
		{`{"version":"3.7.5","platforms":{"darwin-aarch64":{"url":"u","signature":"s"}}}`, true},
		{`{"name":"v3.7.5","url":"u","signature":"s"}`, true},
		{`{"version":"3.7.5"}`, false},
		{`{"format":1,"release":{"version":"4.0.0"},"files":{}}`, false},
	} {
		if got := tauriUpdaterReads(t, []byte(c.feed)); got != c.reads {
			t.Errorf("%s: %v, want %v", c.feed, got, c.reads)
		}
	}
}

func TestManifestRefusesAMissingFile(t *testing.T) {
	dir := t.TempDir()
	names := updateNames("4.0.0")
	left := names[len(names)-1]
	writeFiles(t, dir, names[:len(names)-1])
	err := manifest([]string{"-version", "4.0.0", "-base-url", "https://example.com/v4.0.0", "-policy", policyFile(t, `{}`), dir})
	if err == nil || !strings.Contains(err.Error(), "missing "+left+":") {
		t.Fatalf("manifest: %v, want it to name %s", err, left)
	}
	if _, err := os.Stat(filepath.Join(dir, update.FeedName)); !os.IsNotExist(err) {
		t.Fatalf("the feed was written: %v", err)
	}
}

func TestPolicy(t *testing.T) {
	if _, err := readPolicy("policy.json"); err != nil {
		t.Errorf("the repository's policy: %v", err)
	}
	for _, text := range []string{`{"minimumVersion": "4.0.0"}`, `{"minimum": "four"}`, `nope`} {
		if _, err := readPolicy(policyFile(t, text)); err == nil {
			t.Errorf("%s was accepted", text)
		}
	}
}

// TestPublished checks the names of the files that a release publishes. There must be no
// latest.json and no file under the Tauri app's names (Rclone.UI_*), because other updaters and
// package managers look for those.
func TestPublished(t *testing.T) {
	names := Published("4.0.0-beta.1")
	if len(names) != 17 {
		t.Errorf("%d files: %v", len(names), names)
	}
	// The portable zips are published, but no update installs them.
	updates := updateFiles("4.0.0-beta.1")
	for _, zip := range []string{"Rclone-UI-4.0.0-beta.1-windows-x64-portable.zip", "Rclone-UI-4.0.0-beta.1-windows-arm64-portable.zip"} {
		if !slices.Contains(names, zip) {
			t.Errorf("%s isn't published", zip)
		}
		if _, ok := updates[zip]; ok {
			t.Errorf("%s is an update file", zip)
		}
	}
	for _, n := range names {
		if n == "latest.json" || strings.HasPrefix(n, "Rclone.UI_") {
			t.Errorf("%s is published", n)
		}
		if !strings.HasPrefix(n, "Rclone-UI-4.0.0-beta.1-") && n != update.FeedName && n != "org.rclone.ui.yml" {
			t.Errorf("%s doesn't name its release", n)
		}
	}
	dir := t.TempDir()
	writeFiles(t, dir, names)
	if err := check([]string{"-version", "4.0.0-beta.1", dir}); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, dir, []string{"latest.json"})
	if err := check([]string{"-version", "4.0.0-beta.1", dir}); err == nil || !strings.Contains(err.Error(), "latest.json") {
		t.Errorf("an extra latest.json: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, "latest.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, names[0])); err != nil {
		t.Fatal(err)
	}
	if err := check([]string{"-version", "4.0.0-beta.1", dir}); err == nil || !strings.Contains(err.Error(), names[0]) {
		t.Errorf("a missing %s: %v", names[0], err)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
