package assets

import (
	"io/fs"
	"path"
)

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
