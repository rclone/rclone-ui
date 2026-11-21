//go:build windows

package pathlink

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/i18n"
)

// On Windows, the installer and the portable zip put a console rclone.exe in the bin folder next
// to rcui.exe (see build/windows/rclone-shim), which runs ..\rcui.exe. Enabling the link adds that
// folder to the user's PATH in HKCU\Environment. A copy without it, such as an rcui.exe copied on
// its own, has no rclone.exe to add to PATH.

func newLinker() (*Linker, error) {
	exe, err := platform.Executable()
	if err != nil {
		return nil, err
	}
	l := &Linker{exe: exe, link: filepath.Join(filepath.Dir(exe), "bin"), path: newTerminalPath, userPath: userEnvPath{}}
	if _, err := os.Stat(filepath.Join(l.link, "rclone.exe")); err != nil {
		l.unsupported = i18n.M(`This copy of Rclone UI has no bin\rclone.exe next to it. The installer and the portable zip bring that rclone command.`)
	}
	return l, nil
}

func (l *Linker) Status() State {
	st := State{Supported: l.unsupported.IsZero(), Reason: l.unsupported.Local(), Link: l.link, Target: l.exe}
	// A copy without bin\rclone.exe only has rcui.exe, which is a windowed program, so a terminal
	// doesn't wait for it. bin\rclone.exe is a console program.
	st.Command = psCommand(l.exe)
	if !st.Supported {
		return st
	}
	st.Command = psCommand(filepath.Join(l.link, "rclone.exe"))
	value, err := l.userPath.get()
	st.Enabled = err == nil && pathHas(value, l.link)
	dirs := l.path()
	linkAt := indexOf(dirs, l.link, true)
	user, userAt := l.userRclone(dirs)
	st.UserRclone = user
	userFirst := userAt >= 0 && (linkAt < 0 || userAt < linkAt)
	if st.Enabled {
		st.Warning = warning(l.link, linkAt >= 0, user, userFirst)
		if linkAt >= 0 && !userFirst {
			st.Command = "rclone"
		}
	}
	return st
}

// psCommand returns the command that PowerShell (Windows' usual terminal) uses to run a program
// by its path.
func psCommand(path string) string { return `& "` + path + `"` }

func (l *Linker) Enable() (State, error) {
	if !l.unsupported.IsZero() {
		return l.Status(), unsupported(l.unsupported)
	}
	if err := l.setUserPath(func(v string) string { return pathWith(v, l.link) }); err != nil {
		return l.Status(), err
	}
	return l.Status(), nil
}

func (l *Linker) Disable() (State, error) {
	if err := l.setUserPath(func(v string) string { return pathWithout(v, l.link) }); err != nil {
		return l.Status(), err
	}
	return l.Status(), nil
}

// Refresh does nothing on Windows: the entry on PATH is the copy's own bin folder, which an
// update leaves in place. A portable copy that was moved shows the link as off, and turning it on
// again adds the new folder.
func (l *Linker) Refresh() error { return nil }

// setUserPath rewrites the user's PATH and tells running programs that the environment changed.
// Explorer then reloads it, so new terminals get the new PATH.
func (l *Linker) setUserPath(edit func(string) string) error {
	value, err := l.userPath.get()
	if err != nil {
		return err
	}
	next := edit(value)
	if next == value {
		return nil
	}
	if err := l.userPath.set(next); err != nil {
		return err
	}
	broadcastEnvironment()
	return nil
}

// userRclone returns the first rclone.exe in dirs that isn't this app's, and its position.
func (l *Linker) userRclone(dirs []string) (string, int) {
	for i, d := range dirs {
		if d == "" || samePathSegment(d, l.link) {
			continue
		}
		p := filepath.Join(d, "rclone.exe")
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, i
		}
	}
	return "", -1
}

// userEnvPath reads and writes HKCU\Environment\Path. It is kept as REG_EXPAND_SZ, because it can
// hold variables such as %USERPROFILE%.
type userEnvPath struct{}

func (userEnvPath) get() (string, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Environment`, registry.QUERY_VALUE)
	if err != nil {
		return "", err
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetStringValue("Path")
	if errors.Is(err, registry.ErrNotExist) {
		return "", nil
	}
	return v, err
}

func (userEnvPath) set(value string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Environment`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer func() { _ = k.Close() }()
	return k.SetExpandStringValue("Path", value)
}

// newTerminalPath returns the PATH that a new terminal gets: the machine's PATH, then the user's,
// with variables expanded. The UI's own PATH is still the one it started with, before any change.
func newTerminalPath() []string {
	var dirs []string
	for _, src := range []struct {
		root registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`},
		{registry.CURRENT_USER, `Environment`},
	} {
		k, err := registry.OpenKey(src.root, src.path, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		v, _, err := k.GetStringValue("Path")
		_ = k.Close()
		if err != nil {
			continue
		}
		if expanded, err := registry.ExpandString(v); err == nil {
			v = expanded
		}
		dirs = append(dirs, strings.Split(v, ";")...)
	}
	if len(dirs) == 0 {
		return envPath()
	}
	return dirs
}

var sendMessageTimeout = windows.NewLazySystemDLL("user32.dll").NewProc("SendMessageTimeoutW")

// broadcastEnvironment sends WM_SETTINGCHANGE "Environment" to every top-level window, as setx
// does. Explorer then reloads the environment, and the terminals it starts next see the new PATH.
func broadcastEnvironment() {
	const (
		hwndBroadcast   = 0xffff
		wmSettingChange = 0x001a
		smtoAbortIfHung = 0x0002
	)
	env, err := syscall.UTF16PtrFromString("Environment")
	if err != nil {
		return
	}
	var result uintptr
	_, _, _ = sendMessageTimeout.Call(hwndBroadcast, wmSettingChange, 0, uintptr(unsafe.Pointer(env)),
		smtoAbortIfHung, 5000, uintptr(unsafe.Pointer(&result)))
}
