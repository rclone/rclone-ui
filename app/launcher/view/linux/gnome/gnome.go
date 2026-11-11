// Package gnome holds the files of the launcher's GNOME Shell extension (extension.js). The
// extension places the launcher window on GNOME, where apps can't place their own windows. The
// files are embedded so that every package of the app (deb, rpm, AppImage, Flatpak) can install
// the extension for the user. Ensure installs and enables it once the core is ready.
package gnome

import (
	"embed"
	"encoding/json"
)

// UUID is the extension's UUID, as set in metadata.json.
const UUID = "launcher@rclone.org"

// Files holds the extension's files under their file names. They are installed in
// ~/.local/share/gnome-shell/extensions/<UUID>/.
//
//go:embed metadata.json extension.js
var Files embed.FS

// Version returns the "version" field from a copy of the extension's metadata.json. The version
// goes up with every change to the files. It returns 0 for metadata without a version, or that
// can't be parsed.
func Version(metadata []byte) int {
	var m struct {
		Version int `json:"version"`
	}
	if json.Unmarshal(metadata, &m) != nil {
		return 0
	}
	return m.Version
}

// Ours returns the version of the copy embedded in this build.
func Ours() int {
	data, _ := Files.ReadFile("metadata.json")
	return Version(data)
}

// Action is what to do with the user's copy of the extension (see UserCopy).
type Action int

const (
	// Keep leaves the user's copy as it is, or leaves it absent.
	Keep Action = iota
	// Write replaces the user's copy with this build's, writing the files that differ.
	Write
	// Remove deletes the user's copy, so that the package's copy runs.
	Remove
)

// UserCopy decides what to do with the user's copy of the extension. It takes the versions of the
// copy a package installed for all users (system), the user's copy (user) and this build's copy
// (ours). A version of -1 means that copy isn't installed. GNOME runs the user's copy instead of
// the package's, so the user's copy should only exist while it is the newer one. The result is
// that the newer of the package's and this build's copies runs, and a user copy left by a newer
// build is kept.
func UserCopy(system, user, ours int) Action {
	switch {
	case system >= ours && user >= 0 && user <= system:
		return Remove // it would hide the package's copy, which is at least as new
	case system >= ours:
		return Keep // no user copy, or one from a newer build
	case user <= ours:
		return Write
	}
	return Keep // a copy from a newer build
}
