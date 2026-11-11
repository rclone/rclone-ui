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

// appRunning reports whether the app is running on the default data folder, which is the case
// when its core holds the folder's lock. It uses the core's path rules directly rather than the
// core package, because importing the core package would link every part of the core into the
// rclone CLI.
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

// handOffTimeout limits the second launch, which passes the link on and exits at once.
const handOffTimeout = 30 * time.Second

// handOff asks the running app to update. It launches the app a second time with an update link,
// which the running app receives through its single-instance lock. The app then runs its own
// update flow: it asks the user to confirm the update, because a web page can send the same link,
// and asks again if anything is busy.
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
	// Pass "ui" first. When called through the rclone link, the executable's name alone would make
	// it run as rclone.
	return exec.CommandContext(ctx, exe, "ui", deeplink.UpdateLink(version, string(ch))).Run()
}
