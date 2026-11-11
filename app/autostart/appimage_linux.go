package autostart

import (
	"os"
	"path/filepath"
	"strings"
)

// appImage returns $APPIMAGE when this process runs from that AppImage's mount ($APPDIR), using
// the same rule as pathlink. It returns "" for any other install.
func appImage() string {
	img, dir := os.Getenv("APPIMAGE"), os.Getenv("APPDIR")
	if img == "" || dir == "" {
		return ""
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if !strings.HasPrefix(exe, filepath.Clean(dir)+"/") {
		return ""
	}
	return img
}
