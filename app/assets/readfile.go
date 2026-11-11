package assets

import (
	"io/fs"
	"path"
)

// readFile reads a regular file from tree. A directory is reported as not found.
func readFile(tree fs.FS, name string) ([]byte, error) {
	name = path.Clean(name)
	st, err := fs.Stat(tree, name)
	if err != nil {
		return nil, err
	}
	if st.IsDir() {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return fs.ReadFile(tree, name)
}
