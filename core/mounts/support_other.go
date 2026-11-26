//go:build !windows

package mounts

import "github.com/rclone/rclone-ui/core/errs"

func winFspInstalled() bool { return false }

func installMSI(string) error {
	return errs.Unsupported("winfsp", "Only Windows installs WinFsp.")
}
