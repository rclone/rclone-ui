package update

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/i18n"
)

// detectInstall finds a portable copy first (datadir.Portable). A data folder next to rcui.exe
// makes any copy portable, even one in an install folder, because the app then keeps its data
// there (datadir.Default). Otherwise detectInstall matches the executable's folder against the
// uninstall entry's InstallLocation. A folder that holds the installer's uninstall.exe counts
// too, in case a cleanup tool removed the entry.
func detectInstall() (InstallType, string, i18n.Text) {
	if root, ok := datadir.Portable(); ok {
		return TypePortable, root, i18n.Text{}
	}
	exe, err := platform.Executable()
	if err != nil {
		return TypeUnmanaged, "", i18n.Text{}
	}
	dir := filepath.Dir(exe)
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		if loc := installLocation(root); loc != "" && strings.EqualFold(filepath.Clean(loc), dir) {
			return TypeNSIS, dir, i18n.Text{}
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "uninstall.exe")); err == nil {
		return TypeNSIS, dir, i18n.Text{}
	}
	return TypeUnmanaged, exe, i18n.Text{}
}

// perUser reports whether dir is a per-user install: the folder that the uninstall entry under
// HKCU names. A per-machine install's entry is under HKLM.
func perUser(dir string) bool {
	loc := installLocation(registry.CURRENT_USER)
	return dir != "" && loc != "" && strings.EqualFold(filepath.Clean(loc), filepath.Clean(dir))
}

func installLocation(root registry.Key) string {
	k, err := registry.OpenKey(root, uninstallKey, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetStringValue("InstallLocation")
	if err != nil {
		return ""
	}
	return strings.Trim(strings.TrimSpace(v), `"`)
}
