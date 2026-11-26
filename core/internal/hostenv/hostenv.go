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

func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = Env()
	return cmd
}
