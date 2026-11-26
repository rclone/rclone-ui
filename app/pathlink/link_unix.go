//go:build !windows

package pathlink

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

func (l *Linker) Status() State {
	st := State{Supported: l.unsupported.IsZero(), Reason: l.unsupported.Local(), Link: l.link, Target: l.exe}
	if !st.Supported {
		st.Command = l.command
		if st.Command == "" && l.exe != "" {
			st.Command = shCommand(l.exe, l.path())
		}
		return st
	}
	st.Enabled = l.ours() && sameFile(l.link, l.exe)
	st.NeedsAdmin = l.asAdmin != nil && !writable(filepath.Dir(l.link))
	dirs := l.path()
	linkAt := indexOf(dirs, filepath.Dir(l.link), false)
	user, userAt := l.userRclone(dirs)
	st.UserRclone = user
	userFirst := userAt >= 0 && (linkAt < 0 || userAt < linkAt)
	if st.Enabled {
		st.Warning = warning(filepath.Dir(l.link), linkAt >= 0, user, userFirst)
	}
	st.Command = shCommand(l.exe, dirs)
	if st.Enabled && linkAt >= 0 && !userFirst {
		st.Command = "rclone"
	}
	return st
}

func shCommand(exe string, dirs []string) string {
	if indexOf(dirs, filepath.Dir(exe), false) >= 0 {
		return filepath.Base(exe)
	}
	if strings.Trim(exe, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-+") == "" {
		return exe
	}
	return shQuote(exe)
}

// Enable points the pointer to this app and creates the link, unless something else already has
// the link's name. That includes a broken link, which may be the user's own link to something they
// will put back. A broken link to the pointer belongs to this app, and works again once the
// pointer is fixed.
func (l *Linker) Enable() (State, error) {
	if !l.unsupported.IsZero() {
		return l.Status(), unsupported(l.unsupported)
	}
	if _, err := os.Lstat(l.link); err == nil && !l.ours() {
		return l.Status(), foreign(l.link)
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return l.Status(), err
	}
	if err := l.point(); err != nil {
		return l.Status(), err
	}
	if !l.ours() {
		if err := l.makeLink(); err != nil {
			return l.Status(), err
		}
	}
	return l.Status(), nil
}

func foreign(link string) error {
	shown := errs.Errorf("An rclone that isn't Rclone UI's is already at %s. Rclone UI leaves it as it is: remove it first to use Rclone UI's.", link)
	if target, err := os.Readlink(link); err == nil {
		if _, err := os.Stat(link); errors.Is(err, fs.ErrNotExist) {
			// i18n: %[1]s is the path of the command, and %[2]s where its broken link points.
			shown = errs.Errorf("An rclone that isn't Rclone UI's is already at %[1]s (a link to %[2]s, which no longer exists). "+
				"Rclone UI leaves it as it is: remove it first to use Rclone UI's.", link, target)
		}
	}
	return refusal{shown, ErrForeign}
}

// Disable removes the link if it belongs to this app, and removes the pointer. Another rclone at
// the link's path is kept, even if it is a broken link.
func (l *Linker) Disable() (State, error) {
	if !l.unsupported.IsZero() {
		return l.Status(), nil
	}
	if l.ours() {
		err := os.Remove(l.link)
		if errors.Is(err, fs.ErrPermission) && l.asAdmin != nil {
			q := shQuote(l.link)
			// i18n: The text of macOS's administrator prompt, which asks for the password.
			err = l.asAdmin("if [ -L "+q+" ]; then rm -f "+q+"; fi", i18n.T("Rclone UI wants to remove rclone from your PATH."))
		}
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return l.Status(), err
		}
	}
	if info, err := os.Lstat(l.pointer); err == nil && info.Mode()&fs.ModeSymlink != 0 {
		if err := os.Remove(l.pointer); err != nil {
			return l.Status(), err
		}
	}
	return l.Status(), nil
}

func (l *Linker) Refresh() error {
	if !l.unsupported.IsZero() || !l.ours() {
		return nil
	}
	if target, err := os.Readlink(l.pointer); err == nil && target == l.exe {
		return nil
	}
	return l.point()
}

func (l *Linker) ours() bool {
	info, err := os.Lstat(l.link)
	if err != nil || info.Mode()&fs.ModeSymlink == 0 {
		return false
	}
	target, err := os.Readlink(l.link)
	if err != nil {
		return false
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(l.link), target)
	}
	return filepath.Clean(target) == filepath.Clean(l.pointer) || sameFile(l.link, l.exe)
}

func (l *Linker) point() error {
	if err := os.MkdirAll(filepath.Dir(l.pointer), 0o755); err != nil {
		return err
	}
	return replaceSymlink(l.exe, l.pointer)
}

func (l *Linker) makeLink() error {
	dir := filepath.Dir(l.link)
	if l.asAdmin == nil || writable(dir) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		return replaceSymlink(l.pointer, l.link)
	}
	return l.asAdmin(fmt.Sprintf("mkdir -p %s && ln -sfn %s %s", shQuote(dir), shQuote(l.pointer), shQuote(l.link)),
		// i18n: The text of macOS's administrator prompt, which asks for the password.
		i18n.T("Rclone UI wants to add rclone to your PATH."))
}

func (l *Linker) userRclone(dirs []string) (string, int) {
	for i, dir := range dirs {
		if dir == "" {
			continue
		}
		cand := filepath.Join(dir, "rclone")
		info, err := os.Stat(cand)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		if sameFile(cand, l.exe) || filepath.Clean(cand) == filepath.Clean(l.pointer) {
			continue
		}
		return cand, i
	}
	return "", -1
}

func replaceSymlink(target, name string) error {
	tmp := name + ".rcui-new"
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, name); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func sameFile(a, b string) bool {
	ia, err := os.Stat(a)
	if err != nil {
		return false
	}
	ib, err := os.Stat(b)
	return err == nil && os.SameFile(ia, ib)
}

func writable(dir string) bool {
	for {
		if _, err := os.Stat(dir); err == nil {
			return unix.Access(dir, unix.W_OK) == nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
