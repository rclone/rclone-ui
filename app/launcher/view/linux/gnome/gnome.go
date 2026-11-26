package gnome

import (
	"embed"
	"encoding/json"
)

const UUID = "launcher@rclone.org"

//go:embed metadata.json extension.js
var Files embed.FS

func Version(metadata []byte) int {
	var m struct {
		Version int `json:"version"`
	}
	if json.Unmarshal(metadata, &m) != nil {
		return 0
	}
	return m.Version
}

func Ours() int {
	data, _ := Files.ReadFile("metadata.json")
	return Version(data)
}

type Action int

const (
	Keep Action = iota
	Write
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
		return Remove
	case system >= ours:
		return Keep
	case user <= ours:
		return Write
	}
	return Keep
}
