package update

import (
	"context"
	"errors"
	"fmt"
	"runtime"
)

// Install replaces this copy of Rclone UI with the artifact, in the same way it was installed:
//
//   - macOS: the .app bundle is swapped with a single rename (renamex_np RENAME_SWAP), with an
//     administrator prompt when its folder isn't writable.
//   - Windows: the NSIS installer starts, detached, in passive mode. It waits for this process to
//     exit, then replaces rcui.exe and restarts the app (unless Options.NoRelaunch is set).
//   - Linux: $APPIMAGE is replaced with a single rename. A deb or rpm is installed through pkexec,
//     or through sudo when Options.Terminal is set.
//
// relaunch starts the new version once this process has exited (on macOS, through Launch
// Services). Call it, then exit at once. On Windows the installer starts the app instead, and
// relaunch does nothing. When Install fails, the installed copy is unchanged.
func (e *Engine) Install(ctx context.Context, a *Artifact) (relaunch func() error, err error) {
	if a == nil {
		return nil, errors.New("nothing to install")
	}
	if err := e.installable(a.Kind); err != nil {
		return nil, err
	}
	return e.install(ctx, a)
}

func (e *Engine) installable(k Kind) error {
	e.detect()
	switch k {
	case KindDeb, KindRPM:
		// An explicit --package installs the system package whatever kind of copy this is, as
		// rclone's selfupdate does. A sandboxed copy can't do that.
		if runtime.GOOS != "linux" {
			return errPackageNotLinux
		}
		if e.installed == TypeFlatpak {
			_, why := e.CanSelfUpdate()
			return fmt.Errorf("%w: %s", ErrCantSelfUpdate, why)
		}
		return nil
	}
	if ok, why := e.CanSelfUpdate(); !ok {
		return fmt.Errorf("%w: %s", ErrCantSelfUpdate, why)
	}
	if e.installed.kind() != k {
		return fmt.Errorf("a %s download can't update a %s install", k, e.installed)
	}
	return nil
}

// noRelaunch is the relaunch function for an install that doesn't restart anything itself.
func noRelaunch() error { return nil }
