//go:build !darwin

package interaction

// Dialogs on Windows and Linux come to the front by themselves.
func activate() {}
