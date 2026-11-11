//go:build !windows

package mounts

import "github.com/rclone/rclone-ui/core/errs"

// winFspInstalled is false: WinFsp is only for Windows.
func winFspInstalled() bool { return false }

// installMSI refuses: only Windows has MSI installers. The app has no WinFsp installer on other
// systems, so nothing calls it there.
func installMSI(string) error {
	return errs.Unsupported("winfsp", "Only Windows installs WinFsp.")
}
