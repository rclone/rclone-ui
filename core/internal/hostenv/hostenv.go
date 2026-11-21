// Package hostenv holds the environment for the programs that the core starts, which is the
// host's environment. Under an AppImage, the app's own environment points into the AppImage (its
// libraries, schemas and modules), and a host program such as a Python password command can't run
// with it. The UI knows the host's environment and sets it once, before the core starts.
package hostenv

import (
	"context"
	"os"
	"os/exec"
	"sync"
)

var (
	mu  sync.RWMutex
	env []string
)

// Set makes env the environment for the programs that the core starts. nil means this process's
// environment.
func Set(e []string) {
	mu.Lock()
	defer mu.Unlock()
	env = e
}

func Env() []string {
	mu.RLock()
	defer mu.RUnlock()
	if env == nil {
		return os.Environ()
	}
	return append([]string(nil), env...)
}

// Command is exec.CommandContext with the host's environment.
func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = Env()
	return cmd
}
