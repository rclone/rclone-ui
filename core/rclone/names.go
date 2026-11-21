package rclone

import (
	"slices"

	"github.com/rclone/rclone/fs/fspath"

	"github.com/rclone/rclone-ui/core/errs"
)

// CheckRemoteName refuses name as a remote's name with an errs.Field error on field, or returns
// nil when it can be used. A single ASCII letter is refused on every system. rclone's rc accepts
// it, but on Windows c:path means drive C, and a config made here may later be used on Windows.
// Other one-character names, such as "1" or "é", are not drives, so they are allowed.
func CheckRemoteName(field, name string) error {
	if name == "" {
		return errs.Field(field, "Give the remote a name.")
	}
	if !validName(name) {
		return errs.Field(field, "A name may contain letters, digits, spaces and _ - . + @, and cannot start with - or a space, or end with one.")
	}
	if len(name) == 1 && isASCIILetter(name[0]) {
		return errs.Field(field, "A name can't be a single letter: on Windows that is a drive.")
	}
	return nil
}

// CheckNewRemoteName works like CheckRemoteName, and also refuses a name that is already in use,
// because config/create would overwrite that remote.
func CheckNewRemoteName(field, name string, existing []string) error {
	if err := CheckRemoteName(field, name); err != nil {
		return err
	}
	if slices.Contains(existing, name) {
		return errs.Field(field, "A remote called %s already exists.", name)
	}
	return nil
}

// validName applies rclone's own rule for a remote's name (fspath.CheckConfigName). The name may
// use letters and digits in any script, spaces and _ - . + @. It can't start with - or a space,
// or end with a space.
func validName(name string) bool {
	return fspath.CheckConfigName(name) == nil
}

func isASCIILetter(c byte) bool { return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' }
