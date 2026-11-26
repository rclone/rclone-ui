package update

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

func (e *Engine) install(_ context.Context, a *Artifact) (func() error, error) {
	if a.Kind != KindApp {
		return nil, fmt.Errorf("a %s download can't be installed on macOS", a.Kind)
	}
	return installBundle(a.Path, e.location, filepath.Dir(a.Path))
}

func installBundle(archive, bundle, staging string) (func() error, error) {
	work, err := os.MkdirTemp(filepath.Dir(bundle), ".rcui-update-")
	admin := false
	if err != nil {
		if !errors.Is(err, fs.ErrPermission) {
			return nil, err
		}
		admin = true
		if work, err = os.MkdirTemp(staging, "app-"); err != nil {
			return nil, err
		}
	}
	defer func() { _ = os.RemoveAll(work) }()

	fresh := filepath.Join(work, filepath.Base(bundle))
	if err := untarBundle(archive, fresh); err != nil {
		return nil, err
	}
	exe, err := bundleExecutable(fresh)
	if err != nil {
		return nil, err
	}
	if !admin {
		err = swapBundle(fresh, bundle)
		admin = errors.Is(err, fs.ErrPermission)
	}
	if admin {
		err = swapBundleAsAdmin(fresh, bundle)
	}
	if err != nil {
		return nil, err
	}
	// Updating the modification time makes LaunchServices read the new Info.plist.
	now := time.Now()
	_ = os.Chtimes(bundle, now, now)
	return relaunchAfterExit(openScript, bundle, filepath.Join(bundle, "Contents", "MacOS", exe)), nil
}

// Launch Services gives the new app its own TCC responsible process rather than the old app's.
// -n is needed because Launch Services may still list the exiting instance, and would only
// activate that one.
const openScript = `/usr/bin/open -n -a "$1" || exec "$2"`

// RENAME_SWAP works only on APFS.
func swapBundle(fresh, bundle string) error {
	err := unix.RenamexNp(fresh, bundle, unix.RENAME_SWAP)
	if err == nil {
		return nil
	}
	if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
		return fmt.Errorf("replace %s: %w", bundle, fs.ErrPermission)
	}
	if !errors.Is(err, unix.ENOTSUP) && !errors.Is(err, unix.EINVAL) {
		return fmt.Errorf("replace %s: %w", bundle, err)
	}
	old := fresh + ".old"
	if err := os.Rename(bundle, old); err != nil {
		return fmt.Errorf("replace %s: %w", bundle, err)
	}
	if err := os.Rename(fresh, bundle); err != nil {
		_ = os.Rename(old, bundle)
		return fmt.Errorf("replace %s: %w", bundle, err)
	}
	return nil
}

func swapBundleAsAdmin(fresh, bundle string) error {
	// i18n: The text of macOS's administrator prompt, which asks for the password.
	return runAsAdmin(adminSwapScript(fresh, bundle), i18n.T("Rclone UI wants to install an update."))
}

func adminSwapScript(fresh, bundle string) string {
	old := bundle + ".rcui-old"
	return fmt.Sprintf("rm -rf %[3]s && mv -f %[2]s %[3]s && "+
		"{ mv -f %[1]s %[2]s || { rm -rf %[2]s; mv -f %[3]s %[2]s; exit 1; }; } && rm -rf %[3]s",
		shQuote(fresh), shQuote(bundle), shQuote(old))
}

func runAsAdmin(shellCmd, prompt string) error {
	esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	script := fmt.Sprintf(`do shell script "%s" with administrator privileges with prompt "%s"`,
		esc.Replace(shellCmd), esc.Replace(prompt))
	out, err := exec.Command("/usr/bin/osascript", "-e", script).CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "-128") {
			return errs.New("the administrator prompt was cancelled")
		}
		return errs.Errorf("the administrator prompt failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
