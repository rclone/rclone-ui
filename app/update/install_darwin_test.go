package update

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/i18n"
)

// An update replaces the bundle whole, in place at the same path, even when the new version's
// executable has another name: nothing of the old bundle is left.
func TestInstallBundle(t *testing.T) {
	apps := t.TempDir()
	bundle := filepath.Join(apps, "Rclone UI.app")
	old := filepath.Join(apps, "old.tar.gz")
	writeTarGz(t, old, bundleEntries("rcui-previous", "4.0.1"))
	if err := untarBundle(old, bundle); err != nil {
		t.Fatal(err)
	}

	f := newFeed(t)
	archive := filepath.Join(t.TempDir(), "new.tar.gz")
	writeTarGz(t, archive, bundleEntries("rcui", "4.0.2"))
	content, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	f.stable = f.release("4.0.2", "v1.76.2", KindApp, content)

	e := engineFor(f.options(t, "4.0.1"), TypeApp, bundle)
	rel, err := e.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	art, err := e.Download(context.Background(), rel, nil)
	if err != nil {
		t.Fatal(err)
	}
	relaunch, err := e.Install(context.Background(), art)
	if err != nil {
		t.Fatal(err)
	}
	if relaunch == nil {
		t.Error("no relaunch")
	}
	if exe, err := bundleExecutable(bundle); err != nil || exe != "rcui" {
		t.Errorf("the bundle runs %q (%v), want rcui", exe, err)
	}
	if _, err := os.Stat(filepath.Join(bundle, "Contents", "MacOS", "rcui-previous")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the old executable is still there: %v", err)
	}
	entries, _ := os.ReadDir(apps)
	for _, ent := range entries {
		if ent.Name() != "Rclone UI.app" && ent.Name() != "old.tar.gz" {
			t.Errorf("left behind: %s", ent.Name())
		}
	}
}

func TestInstallRefuses(t *testing.T) {
	for _, c := range []struct {
		it      InstallType
		blocked string
		want    string
	}{
		{TypeUnmanaged, "", "No installer put"},
		{TypeFlatpak, "", "Flathub"},
		{TypeApp, "macOS runs this Rclone UI from a temporary copy", "temporary copy"},
		{TypeNSIS, "", "a app download can't update a nsis install"},
	} {
		e := engineFor(Options{}, c.it, "/Applications/Rclone UI.app")
		e.blocked = i18n.M(c.blocked)
		_, err := e.Install(context.Background(), &Artifact{Path: "/nonexistent", Kind: KindApp})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: Install = %v, want %q", c.it, err, c.want)
		}
	}
}

func TestAdminSwapScript(t *testing.T) {
	apps := t.TempDir()
	bundle := filepath.Join(apps, "Rclone UI.app")
	fresh := filepath.Join(t.TempDir(), "it's new.app")
	write := func(dir, version string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, "Contents"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "Contents", "version"), []byte(version), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	installed := func() string {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(bundle, "Contents", "version"))
		if err != nil {
			t.Fatalf("no app at its path: %v", err)
		}
		return string(b)
	}
	leftovers := func() {
		t.Helper()
		if entries, _ := os.ReadDir(apps); len(entries) != 1 {
			t.Errorf("%d entries next to the app, want only it", len(entries))
		}
	}
	write(bundle, "old")

	// The new bundle isn't there, so the second move fails.
	if out, err := exec.Command("/bin/sh", "-c", adminSwapScript(filepath.Join(apps, "missing.app"), bundle)).CombinedOutput(); err == nil {
		t.Fatalf("a failed move succeeded: %s", out)
	}
	if v := installed(); v != "old" {
		t.Errorf("after a failed swap the app is %q, want the old one", v)
	}
	leftovers()

	write(fresh, "new")
	if out, err := exec.Command("/bin/sh", "-c", adminSwapScript(fresh, bundle)).CombinedOutput(); err != nil {
		t.Fatalf("swap: %v: %s", err, out)
	}
	if v := installed(); v != "new" {
		t.Errorf("after the swap the app is %q, want the new one", v)
	}
	leftovers()
}

// When Launch Services can't open a bundle, the script falls back to running its executable.
func TestRelaunchFallsBack(t *testing.T) {
	dir := t.TempDir()
	ran := filepath.Join(dir, "ran")
	exe := filepath.Join(dir, "rcui")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho ran > "+shQuote(ran)+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A process that has exited and been reaped.
	gone := exec.Command("true")
	if err := gone.Run(); err != nil {
		t.Fatal(err)
	}
	if err := relaunchAfter(gone.Process.Pid, openScript, "/nonexistent/Nope.app", exe); err != nil {
		t.Fatal(err)
	}
	waitForFile(t, ran, 10*time.Second)
}
