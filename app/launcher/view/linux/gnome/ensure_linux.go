//go:build linux

package gnome

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/rclone/rclone-ui/app/platform"
)

const (
	shellExtensions     = platform.GnomeShellExtensions
	shellExtensionsPath = dbus.ObjectPath("/org/gnome/Shell/Extensions")
)

// Ensure installs and enables the extension without asking. GNOME doesn't let an app place its
// own window, so the extension places the launcher's window. The files come from the package
// (deb or rpm) or from the user's copy, which is kept in sync with this build. The shell's D-Bus
// service can only enable an extension that the shell has loaded. The shell loads extensions at
// login, so an extension it hasn't loaded is added to its enabled list for the next login. On a
// desktop other than GNOME, Ensure does nothing.
func Ensure(ctx context.Context, log *slog.Logger, acks Acks) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	shell := conn.Object(shellExtensions, shellExtensionsPath)
	var info map[string]dbus.Variant
	if err := shell.CallWithContext(ctx, shellExtensions+".GetExtensionInfo", 0, UUID).Store(&info); err != nil {
		log.Info("the launcher's window is placed by the compositor: no GNOME Shell", "error", err)
		return
	}
	if err := syncUserCopy(log); err != nil {
		log.Error("could not install the launcher's GNOME extension", "error", err)
		return
	}
	state := 0
	if v, ok := info["state"]; ok {
		state = extensionState(v.Value())
	}
	switch {
	case state == extensionActive:
		acks.Add(ctx, enabledAck)
	case acks.Has(ctx, enabledAck):
		// It was enabled once already, so if it is off now, the user turned it off.
	case state != 0:
		var ok bool
		if err := shell.CallWithContext(ctx, shellExtensions+".EnableExtension", 0, UUID).Store(&ok); err != nil || !ok {
			log.Warn("could not enable the launcher's GNOME extension", "state", state, "error", err)
			return
		}
		log.Info("enabled the launcher's GNOME extension")
		acks.Add(ctx, enabledAck)
	default:
		if err := enableAtLogin(ctx); err != nil {
			// This is a Flatpak, or gsettings is missing. The first start after the next login
			// enables the extension, because the shell will have loaded it by then. (A Flatpak
			// can talk to the shell, because the Flatpak gate requires that on GNOME.)
			log.Info("the launcher's GNOME extension is enabled at a later start", "error", err)
			return
		}
		log.Info("the launcher's GNOME extension runs from the next login")
		acks.Add(ctx, enabledAck)
	}
}

// syncUserCopy writes or removes the user's copy of the extension, as UserCopy decides. The change
// takes effect at the next login.
func syncUserCopy(log *slog.Logger) error {
	dir, err := userDir()
	if err != nil {
		return err
	}
	system, user := systemVersion(), versionIn(dir)
	switch UserCopy(system, user, Ours()) {
	case Write:
		return install(dir)
	case Remove:
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
		log.Info("removed the user's copy of the launcher's GNOME extension: the package's is as new",
			"user", user, "package", system)
	}
	return nil
}

// systemVersion returns the version of the copy that a package (deb or rpm) installed for every
// user, and that is removed with the package. It returns -1 when there is none. A Flatpak sees its
// runtime's data directories, never the host's.
func systemVersion() int {
	dirs := os.Getenv("XDG_DATA_DIRS")
	if dirs == "" {
		dirs = "/usr/local/share:/usr/share"
	}
	for _, d := range filepath.SplitList(dirs) {
		if v := versionIn(filepath.Join(d, "gnome-shell", "extensions", UUID)); v >= 0 {
			return v
		}
	}
	return -1
}

// versionIn returns the version of the copy in dir, or -1 when there is none.
func versionIn(dir string) int {
	data, err := os.ReadFile(filepath.Join(dir, "metadata.json"))
	if err != nil {
		return -1
	}
	return Version(data)
}

// userDir returns the folder for the user's copy. Inside a Flatpak, XDG_DATA_HOME points to the
// app's own folder, so ~/.local/share is used instead (the app has access to the home folder).
func userDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" || platform.IsFlatpak() {
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "gnome-shell", "extensions", UUID), nil
}

// install writes the extension's files to dir, skipping files that already match this build's.
func install(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return fs.WalkDir(Files, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := Files.ReadFile(path)
		if err != nil {
			return err
		}
		dst := filepath.Join(dir, path)
		if old, err := os.ReadFile(dst); err == nil && bytes.Equal(old, data) {
			return nil
		}
		return os.WriteFile(dst, data, 0o644)
	})
}

// enableAtLogin adds the extension to GNOME's list of enabled extensions (org.gnome.shell
// enabled-extensions), which the shell reads at login.
func enableAtLogin(ctx context.Context) error {
	if platform.IsFlatpak() {
		// The sandbox has its own gsettings, separate from the desktop's. Writing to them would
		// succeed and change nothing.
		return errors.New("a Flatpak's gsettings are its own")
	}
	// Run the host's gsettings in the host's environment, because an AppImage's schemas aren't
	// GNOME's.
	get := platform.HostCommand(ctx, "gsettings", "get", "org.gnome.shell", "enabled-extensions")
	if get.Err != nil {
		return errors.New("no gsettings")
	}
	out, err := get.Output()
	if err != nil {
		return err
	}
	list := parseStrv(string(out))
	if slices.Contains(list, UUID) {
		return nil
	}
	return platform.HostCommand(ctx, "gsettings", "set", "org.gnome.shell", "enabled-extensions",
		formatStrv(append(list, UUID))).Run()
}
