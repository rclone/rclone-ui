//go:build !darwin

package app

// osEndingSession always returns false here. Only macOS reports the end of a session through
// shouldQuit. Windows reports it in WM_ENDSESSION (see wndProc), and on Linux a logout ends the UI
// and the core together.
func osEndingSession() bool { return false }
