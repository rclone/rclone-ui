package app

import (
	"os"
	"path/filepath"
	"runtime/debug"
)

// crashLogLimit is the size above which crash.log starts over at the next start.
const crashLogLimit = 1 << 20

// keepCrashes makes the Go runtime write a fatal crash to crash.log, in the logs folder: a panic
// that nothing recovered, on any goroutine, or a fatal error. The app's own log can't hold it,
// because the log is closed by the time the panic ends the process. Recovered panics are in the
// app's log.
func keepCrashes(dir string) {
	path := filepath.Join(dir, "crash.log")
	flags := os.O_WRONLY | os.O_CREATE | os.O_APPEND
	if fi, err := os.Stat(path); err == nil && fi.Size() > crashLogLimit {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return
	}
	defer f.Close() // SetCrashOutput keeps its own copy of the file
	_ = debug.SetCrashOutput(f, debug.CrashOptions{})
}
