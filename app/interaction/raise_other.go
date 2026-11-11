//go:build !windows

package interaction

// raise does nothing outside Windows (see raise_windows.go), because macOS keeps osascript's prompt
// in front by itself.
func raise(string) (stop func()) { return func() {} }
