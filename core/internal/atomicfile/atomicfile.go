// Package atomicfile replaces a file's contents so that a crash, or a reader at any moment, sees
// either the whole old file or the whole new one, never a mix or a partial file.
package atomicfile

import (
	"os"
	"path/filepath"
	"runtime"
)

// WriteFile writes data to path through a temporary file in the same folder. Each call uses its
// own temporary file, so two writers never share one. The temporary file is written, synced and
// closed, and then renamed over path. The folder is synced afterward, so the rename itself
// survives a power cut. The resulting file has mode perm, whether it is new or replaced.
func WriteFile(path string, data []byte, perm os.FileMode) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tmp.Close() // after a late failure, a second Close only reports that it's closed
			_ = os.Remove(tmp.Name())
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Chmod(perm); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	// The new file is in place. Some folders can't be synced (Windows can't open a folder for
	// it, and some file systems refuse). Even then, a power cut leaves either the whole old file
	// or the whole new one.
	_ = syncDir(dir)
	return nil
}

func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}
