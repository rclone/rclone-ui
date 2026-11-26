//go:build !windows

package interaction

// macOS keeps osascript's prompt in front by itself.
func raise(string) (stop func()) { return func() {} }
