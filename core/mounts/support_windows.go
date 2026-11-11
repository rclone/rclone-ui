package mounts

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

// winFspInstalled reports whether WinFsp is installed where rclone looks for it: the DLL for this
// architecture, in the bin folder of the folder that WinFsp's registry key names. On 64-bit
// Windows the key is in the registry's 32-bit view, which is where rclone's FUSE library
// (cgofuse) reads it.
func winFspInstalled() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\WinFsp`, registry.QUERY_VALUE|registry.WOW64_32KEY)
	if err != nil {
		return false
	}
	defer k.Close()
	dir, _, err := k.GetStringValue("InstallDir")
	if err != nil || dir == "" {
		return false
	}
	dll := "winfsp-x64.dll"
	if runtime.GOARCH == "arm64" {
		dll = "winfsp-a64.dll"
	}
	_, err = os.Stat(filepath.Join(dir, "bin", dll))
	return err == nil
}

// The exit codes of msiexec that installMSI tells apart.
const (
	msiRestartNeeded = 3010 // installed, and Windows wants a restart
	msiUserExit      = 1602 // the user cancelled
	msiCancelled     = 1223 // the user said no to the administrator prompt
)

// installMSI runs the installer at path with a progress window (msiexec /passive), and waits for
// it. WinFsp installs for the whole machine, so msiexec asks Windows for administrator rights
// before it changes anything.
func installMSI(path string) error {
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return errs.Internal(err)
	}
	err = exec.Command(filepath.Join(system, "msiexec.exe"), "/i", path, "/passive", "/norestart").Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		if err != nil {
			return errs.Said(errs.CodeInternal, i18n.M("The WinFsp installer could not start: %v.", err))
		}
		return nil
	}
	switch code := exit.ExitCode(); code {
	case msiRestartNeeded:
		return nil
	case msiUserExit, msiCancelled:
		return errs.Canceled("WinFsp wasn't installed.")
	default:
		return errs.Said(errs.CodeInternal, i18n.M("The WinFsp installer failed with code %d.", code))
	}
}
