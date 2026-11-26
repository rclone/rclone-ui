package update

import (
	"context"
	"errors"
	"fmt"
	"runtime"
)

// Install replaces this copy of Rclone UI with the artifact, in the same way it was installed.
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

func noRelaunch() error { return nil }
