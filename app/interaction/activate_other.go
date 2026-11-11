//go:build !darwin

package interaction

// activate does nothing, because dialogs on Windows and Linux come to the front by themselves.
func activate() {}
