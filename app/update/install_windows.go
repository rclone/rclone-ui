package update

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"

	"github.com/rclone/rclone-ui/core/errs"
)

func (e *Engine) install(_ context.Context, a *Artifact) (func() error, error) {
	if a.Kind != KindNSIS {
		return nil, fmt.Errorf("a %s download can't be installed on Windows", a.Kind)
	}
	if perUser(e.InstallLocation()) {
		// A per-user install needs no administrator rights, so its update should show no UAC
		// prompt. But the installer asks for the highest rights the user has, which for an
		// administrator means a prompt. RunAsInvoker makes Windows start the installer with the
		// user's own rights instead. ShellExecute passes this process's environment on, so the
		// variable is set only while the installer starts. The installer clears it for the
		// programs that it starts (project.nsi's .onInit).
		restore, err := setEnv(compatLayer, "RunAsInvoker")
		if err != nil {
			return nil, err
		}
		defer restore()
	}
	if err := runInstaller(a.Path, nsisArgs(os.Getpid(), !e.opts.NoRelaunch)); err != nil {
		return nil, err
	}
	return noRelaunch, nil
}

// compatLayer is the environment variable that sets Windows' compatibility layers for a program.
const compatLayer = "__COMPAT_LAYER"

func setEnv(key, value string) (restore func(), err error) {
	old, had := os.LookupEnv(key)
	if err := os.Setenv(key, value); err != nil {
		return nil, err
	}
	return func() {
		if had {
			_ = os.Setenv(key, old)
		} else {
			_ = os.Unsetenv(key)
		}
	}, nil
}

// nsisArgs returns the installer's switches (see build/windows/nsis/project.nsi). /P runs it in
// passive mode, with a progress window and no questions. /UPDATE updates the installed copy, with
// no new shortcuts and no uninstall. /WAITPID waits for this process to exit. /R starts the app
// when the installer is done.
func nsisArgs(pid int, relaunch bool) string {
	args := []string{"/P", "/UPDATE", fmt.Sprintf("/WAITPID=%d", pid)}
	if relaunch {
		args = append(args, "/R")
	}
	return strings.Join(args, " ")
}

// runInstaller starts the installer, detached, through the shell. The shell shows the UAC prompt
// that a per-machine install needs, where CreateProcess would fail with ERROR_ELEVATION_REQUIRED.
func runInstaller(installer, args string) error {
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	file, err := windows.UTF16PtrFromString(installer)
	if err != nil {
		return err
	}
	params, err := windows.UTF16PtrFromString(args)
	if err != nil {
		return err
	}
	dir, err := windows.UTF16PtrFromString(filepath.Dir(installer))
	if err != nil {
		return err
	}
	if err := windows.ShellExecute(0, verb, file, params, dir, windows.SW_SHOWNORMAL); err != nil {
		if err == windows.ERROR_CANCELLED {
			return errs.New("the administrator prompt was cancelled")
		}
		return errs.Errorf("could not start the installer: %w", err)
	}
	return nil
}
