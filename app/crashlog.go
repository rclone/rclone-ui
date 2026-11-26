package app

import (
	"os"
	"path/filepath"
	"runtime/debug"
)

const crashLogLimit = 1 << 20

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
