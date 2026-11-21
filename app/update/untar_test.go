package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// tarEntry is one entry of a test archive: a file (body), a folder (dir) or a link (link).
type tarEntry struct {
	name, body, link string
	dir              bool
	mode             int64
}

func writeTarGz(t *testing.T, file string, entries []tarEntry) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Mode: e.mode}
		switch {
		case e.dir:
			h.Typeflag, h.Mode = tar.TypeDir, 0o755
		case e.link != "":
			h.Typeflag, h.Linkname, h.Mode = tar.TypeSymlink, e.link, 0o777
		default:
			h.Typeflag, h.Size = tar.TypeReg, int64(len(e.body))
			if h.Mode == 0 {
				h.Mode = 0o644
			}
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func infoPlist(exe, version string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Rclone UI</string>
	<key>CFBundleURLTypes</key>
	<array><dict><key>CFBundleExecutable</key><string>not this one</string></dict></array>
	<key>CSResourcesFileMapped</key>
	<true/>
	<key>CFBundleExecutable</key>
	<string>` + exe + `</string>
	<key>CFBundleShortVersionString</key>
	<string>` + version + `</string>
</dict>
</plist>`
}

// bundleEntries is an app bundle laid out the way build/updater's tar-app writes it.
func bundleEntries(exe, version string) []tarEntry {
	return []tarEntry{
		{name: "Rclone UI.app/", dir: true},
		{name: "Rclone UI.app/Contents/", dir: true},
		{name: "Rclone UI.app/Contents/Info.plist", body: infoPlist(exe, version)},
		{name: "Rclone UI.app/Contents/MacOS/", dir: true},
		{name: "Rclone UI.app/Contents/MacOS/" + exe, body: "#!/bin/sh\necho " + version + "\n", mode: 0o755},
		{name: "Rclone UI.app/Contents/Resources/icon.icns", body: "icon"},
		{name: "Rclone UI.app/Contents/Resources/current", link: "icon.icns"},
	}
}

func TestUntarBundle(t *testing.T) {
	// Only macOS installs an app bundle, and Windows files have no execute bit to keep.
	if runtime.GOOS == "windows" {
		t.Skip("an app bundle is installed on macOS only")
	}
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tar.gz")
	writeTarGz(t, archive, bundleEntries("rcui", "4.0.2"))
	dst := filepath.Join(dir, "out", "Rclone UI.app")
	if err := untarBundle(archive, dst); err != nil {
		t.Fatal(err)
	}
	exe, err := bundleExecutable(dst)
	if err != nil || exe != "rcui" {
		t.Fatalf("bundleExecutable = %q, %v", exe, err)
	}
	info, err := os.Stat(filepath.Join(dst, "Contents", "MacOS", "rcui"))
	if err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Errorf("the executable lost its mode: %v %v", info, err)
	}
	if target, err := os.Readlink(filepath.Join(dst, "Contents", "Resources", "current")); err != nil || target != "icon.icns" {
		t.Errorf("link = %q, %v", target, err)
	}
	if v, err := plistString(filepath.Join(dst, "Contents", "Info.plist"), "CFBundleShortVersionString"); err != nil || v != "4.0.2" {
		t.Errorf("version = %q, %v", v, err)
	}
}

func TestUntarBundleRefusesEscapes(t *testing.T) {
	for _, c := range []struct {
		name  string
		entry tarEntry
	}{
		{"dot-dot path", tarEntry{name: "Rclone UI.app/../../evil", body: "x"}},
		{"absolute path", tarEntry{name: "/etc/evil", body: "x"}},
		{"absolute link", tarEntry{name: "Rclone UI.app/Contents/l", link: "/etc/passwd"}},
		{"link out", tarEntry{name: "Rclone UI.app/Contents/l", link: "../../../../etc"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			archive := filepath.Join(dir, "a.tar.gz")
			writeTarGz(t, archive, append(bundleEntries("rcui", "4.0.2"), c.entry))
			err := untarBundle(archive, filepath.Join(dir, "out", "Rclone UI.app"))
			if err == nil || !strings.Contains(err.Error(), "the update archive") {
				t.Errorf("untarBundle = %v", err)
			}
		})
	}
}

func TestUntarBundleRefusesLinkChains(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tar.gz")
	writeTarGz(t, archive, append(bundleEntries("rcui", "4.0.2"),
		tarEntry{name: "Rclone UI.app/d/", dir: true},
		tarEntry{name: "Rclone UI.app/d/up", link: ".."},
		tarEntry{name: "Rclone UI.app/d/up/up2", link: ".."},
		tarEntry{name: "Rclone UI.app/d/up/up2/evil", body: "x"},
	))
	out := filepath.Join(dir, "out")
	if err := untarBundle(archive, filepath.Join(out, "Rclone UI.app")); err == nil {
		t.Error("untarBundle unpacked through a chain of links")
	}
	if _, err := os.Stat(filepath.Join(out, "evil")); err == nil {
		t.Error("the archive wrote outside the app")
	}
}

func TestBundleExecutableMissing(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tar.gz")
	entries := bundleEntries("rcui", "4.0.2")
	writeTarGz(t, archive, entries[:3]) // Info.plist without the executable
	dst := filepath.Join(dir, "Rclone UI.app")
	if err := untarBundle(archive, dst); err != nil {
		t.Fatal(err)
	}
	if _, err := bundleExecutable(dst); err == nil {
		t.Error("a bundle without its executable passed")
	}
}
