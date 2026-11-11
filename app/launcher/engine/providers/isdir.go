package providers

import "os"

// isDir reports whether a dropped path is a folder. A path that no longer exists is not.
func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
