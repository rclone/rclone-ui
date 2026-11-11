package platform

import (
	"context"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
)

// An AppImage's AppRun and linuxdeploy's GTK hook point the environment into the AppImage's mount
// (its AppDir). With that environment, the host's programs would load the AppImage's libraries,
// schemas and modules instead of their own, and fail. This affects xdg-open and the browser it
// starts, gsettings, the login shell and a Python password command. So these programs get the
// host's environment (see HostEnv). The UI keeps its own environment, because its GTK reads module
// paths lazily.

// listVars are the colon-separated variables that AppRun and the GTK hook point into the AppDir.
// Most get the AppDir's folders in front of the host's value. The GTK hook replaces the values of
// GSETTINGS_SCHEMA_DIR, GI_TYPELIB_PATH and GTK_PATH with a single folder in the AppDir.
var listVars = map[string]bool{
	"PATH": true, "LD_LIBRARY_PATH": true, "XDG_DATA_DIRS": true, "PYTHONPATH": true,
	"PERLLIB": true, "QT_PLUGIN_PATH": true, "GSETTINGS_SCHEMA_DIR": true, "GI_TYPELIB_PATH": true,
	"GTK_PATH": true,
}

// setVars are the variables that AppRun and the GTK hook set outright. They are kept only when
// they don't point into the AppDir. The GTK hook sets the GTK and GDK ones for GTK 4. Wails'
// AppRun sets WEBKIT_INJECTED_BUNDLE_PATH, which would make a host program that uses WebKitGTK
// load the AppImage's injected bundle.
var setVars = map[string]bool{
	"PYTHONHOME": true, "GTK_DATA_PREFIX": true, "GTK_EXE_PREFIX": true,
	"GDK_PIXBUF_MODULE_FILE": true, "WEBKIT_INJECTED_BUNDLE_PATH": true,
}

// dropVars are always dropped, whatever their value. They are the AppImage's own variables
// (APPDIR, APPIMAGE, ARGV0, OWD), and the ones that hold no path: GTK_THEME and GDK_BACKEND, which
// the GTK hook forces, and PYTHONDONTWRITEBYTECODE, which AppImageKit's AppRun sets. For those,
// the AppImage's value can't be told apart from the user's, so a host program uses its default.
var dropVars = map[string]bool{
	"APPDIR": true, "APPIMAGE": true, "ARGV0": true, "OWD": true,
	"GTK_THEME": true, "GDK_BACKEND": true, "PYTHONDONTWRITEBYTECODE": true,
}

// hostEnv returns env as a host program should get it, given the AppDir. It returns env unchanged
// when appdir is "".
func hostEnv(env []string, appdir string) []string {
	if appdir == "" {
		return env
	}
	appdir = path.Clean(appdir)
	inside := func(p string) bool {
		p = path.Clean(p)
		return p == appdir || strings.HasPrefix(p, appdir+"/")
	}
	out := make([]string, 0, len(env))
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		switch {
		case !ok:
			out = append(out, kv)
		case listVars[k]:
			var keep []string
			for p := range strings.SplitSeq(v, ":") {
				if p != "" && !inside(p) {
					keep = append(keep, p)
				}
			}
			if len(keep) > 0 {
				out = append(out, k+"="+strings.Join(keep, ":"))
			}
		case dropVars[k]:
		case setVars[k] && inside(v):
		default:
			out = append(out, kv)
		}
	}
	return out
}

// appDir returns appdir when this executable runs from that AppImage's mount, and "" otherwise.
// The AppImage's runtime sets both variables. A program that the AppImage started inherits them,
// but isn't inside the mount.
func appDir(appimage, appdir, exe string) string {
	if appimage == "" || appdir == "" || !strings.HasPrefix(exe, path.Clean(appdir)+"/") {
		return ""
	}
	return appdir
}

// AppDir returns the AppImage mount that this executable runs from, or "" when it isn't running
// from an AppImage.
func AppDir() string {
	exe, err := Executable()
	if err != nil {
		return ""
	}
	return appDir(os.Getenv("APPIMAGE"), os.Getenv("APPDIR"), exe)
}

// HostEnv returns the environment for a host program. It is this process's environment, without
// the AppImage's entries when the process runs from an AppImage.
func HostEnv() []string { return hostEnv(os.Environ(), AppDir()) }

// HostCommand prepares a host program to run. Under an AppImage, the program is looked up only on
// the host's PATH and runs in the host's environment (see HostEnv). Otherwise it is the same as
// exec.CommandContext.
func HostCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	dir := AppDir()
	if dir == "" {
		return cmd
	}
	cmd.Env = hostEnv(os.Environ(), dir)
	if !strings.Contains(name, "/") {
		if found, ok := lookPathIn(name, envValue(cmd.Env, "PATH")); ok {
			cmd.Path, cmd.Err = found, nil
		} else {
			cmd.Path, cmd.Err = name, &exec.Error{Name: name, Err: exec.ErrNotFound}
		}
	}
	return cmd
}

func envValue(env []string, key string) string {
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, key+"="); ok {
			return v
		}
	}
	return ""
}

// lookPathIn finds an executable file named name in the folders of list, which is a PATH value.
func lookPathIn(name, list string) (string, bool) {
	for _, dir := range filepath.SplitList(list) {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0 {
			return p, true
		}
	}
	return "", false
}
