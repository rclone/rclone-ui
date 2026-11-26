package providers

import "os"

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
