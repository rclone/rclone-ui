package update

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/rclone/rclone-ui/core/errs"
)

func (e *Engine) install(ctx context.Context, a *Artifact) (func() error, error) {
	switch a.Kind {
	case KindAppImage:
		if err := replaceFile(a.Path, e.location); err != nil {
			return nil, err
		}
		return relaunchAfterExit(execScript, e.location), nil
	case KindDeb, KindRPM:
		if err := e.installPackage(ctx, a); err != nil {
			return nil, err
		}
		return relaunchAfterExit(execScript, packagedExecutable), nil
	}
	return nil, fmt.Errorf("a %s download can't be installed on Linux", a.Kind)
}

// packagedExecutable is the path where the deb and rpm install rcui.
const packagedExecutable = "/usr/bin/rcui"

// replaceFile moves src to dst with a single rename, through a temporary file next to dst, and
// keeps dst's permissions. A running AppImage keeps using its mounted image, which the rename
// doesn't affect.
func replaceFile(src, dst string) error {
	mode := os.FileMode(0o755)
	if info, err := os.Stat(dst); err == nil {
		mode = info.Mode().Perm() | 0o111
	}
	tmp := filepath.Join(filepath.Dir(dst), "."+filepath.Base(dst)+".update")
	_ = os.Remove(tmp)
	if err := os.Rename(src, tmp); err != nil {
		if err := copyFile(src, tmp, mode); err != nil {
			return errs.Errorf("could not write next to %s: %w", dst, err)
		}
	}
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return errs.Errorf("could not replace %s: %w", dst, err)
	}
	return nil
}

// installPackage runs dpkg or rpm as root. It runs them directly when already root, through sudo
// from a terminal, or else through pkexec (the desktop's password prompt). rpm gets --oldpackage
// and --replacepkgs, because downgrades and reinstalls are allowed.
func (e *Engine) installPackage(ctx context.Context, a *Artifact) error {
	args := []string{"dpkg", "-i", a.Path}
	if a.Kind == KindRPM {
		args = []string{"rpm", "-U", "--oldpackage", "--replacepkgs", a.Path}
	}
	switch {
	case os.Geteuid() == 0:
	case e.opts.Terminal:
		args = append([]string{"sudo"}, args...)
	default:
		args = append([]string{"pkexec"}, args...)
	}
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	var out []byte
	var err error
	if e.opts.Terminal {
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		err = cmd.Run()
	} else {
		out, err = cmd.CombinedOutput()
	}
	if err != nil {
		var exit *exec.ExitError
		if args[0] == "pkexec" && errors.As(err, &exit) && (exit.ExitCode() == 126 || exit.ExitCode() == 127) {
			return errs.New("the administrator prompt was cancelled")
		}
		return fmt.Errorf("%s failed: %w %s", args[0], err, out)
	}
	return nil
}
