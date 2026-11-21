//go:build !darwin && !linux && !windows

package update

import (
	"context"
	"errors"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/i18n"
)

func detectInstall() (InstallType, string, i18n.Text) {
	exe, _ := platform.Executable()
	return TypeUnmanaged, exe, i18n.Text{}
}

func (e *Engine) install(context.Context, *Artifact) (func() error, error) {
	return nil, errors.New("Rclone UI doesn't update itself on this system")
}
