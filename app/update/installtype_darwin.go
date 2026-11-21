package update

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/core/i18n"
)

// detectInstall finds the .app bundle that contains the executable. A bundle that macOS
// translocated (because it was opened straight from a download) or one on a read-only volume (its
// disk image) can't be replaced.
func detectInstall() (InstallType, string, i18n.Text) {
	exe, err := platform.Executable()
	if err != nil {
		return TypeUnmanaged, "", i18n.Text{}
	}
	i := strings.Index(exe, ".app/Contents/MacOS/")
	if i < 0 {
		return TypeUnmanaged, exe, i18n.Text{}
	}
	bundle := exe[:i+len(".app")]
	switch {
	case strings.Contains(bundle, "/AppTranslocation/"):
		return TypeApp, bundle, i18n.M("macOS runs this Rclone UI from a temporary copy: move it to Applications and open it from there to update it.")
	case readOnlyVolume(filepath.Dir(bundle)):
		return TypeApp, bundle, i18n.M("Rclone UI runs from a read-only volume (its disk image?): copy it to Applications and open it from there to update it.")
	}
	return TypeApp, bundle, i18n.Text{}
}

func readOnlyVolume(dir string) bool {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return false
	}
	return st.Flags&unix.MNT_RDONLY != 0
}
