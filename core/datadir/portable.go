package datadir

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

const PortableDir = "data"

// Portable reports whether this copy of the app is portable, and returns its folder: the
// executable's folder, with symlinks resolved. A copy is portable on Windows when a folder named
// data is next to its executable. The answer is read once, so it stays the same while the process
// runs, even if the folder is created or deleted meanwhile.
func Portable() (root string, ok bool) { return portableOnce() }

var portableOnce = sync.OnceValues(func() (string, bool) {
	exe, err := os.Executable()
	if err != nil {
		return "", false
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return portable(runtime.GOOS, exe, os.Stat)
})

func portable(goos, exe string, stat func(string) (os.FileInfo, error)) (string, bool) {
	if goos != "windows" || exe == "" {
		return "", false
	}
	root := filepath.Dir(exe)
	info, err := stat(filepath.Join(root, PortableDir))
	if err != nil || !info.IsDir() {
		return "", false
	}
	return root, true
}
