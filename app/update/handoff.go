package update

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/rclone/rclone-ui/app/deeplink"
	"github.com/rclone/rclone-ui/core/datadir"
)

func appRunning() bool {
	dir, err := datadir.Default()
	if err != nil {
		return false
	}
	release, err := datadir.Lock(context.Background(), dir, 0)
	if err != nil {
		return errors.Is(err, datadir.ErrLocked)
	}
	release()
	return false
}

const handOffTimeout = 30 * time.Second

func handOff(ctx context.Context, version string, ch Channel) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	ctx, cancel := context.WithTimeout(ctx, handOffTimeout)
	defer cancel()
	return exec.CommandContext(ctx, exe, "ui", deeplink.UpdateLink(version, string(ch))).Run()
}
