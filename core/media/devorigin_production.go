//go:build production

package media

// devServerURL is empty, because a release build never loads its pages from a dev server.
func devServerURL() string { return "" }
