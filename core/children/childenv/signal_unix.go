//go:build !windows

package childenv

import (
	"os/signal"
	"syscall"
)

// IgnoreSIGPIPE makes a write to a closed pipe return an error instead of ending the process. A
// child of the core needs this, because Go ends a process at its first write to a broken fd 1 or
// 2. Without it, a log line written after the app died would kill the child before it has
// unmounted. signal.Ignore installs no handler, so rclone's handler (lib/atexit) stays the only
// one.
func IgnoreSIGPIPE() { signal.Ignore(syscall.SIGPIPE) }
