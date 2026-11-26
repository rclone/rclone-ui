package rclone

import (
	"slices"

	"github.com/rclone/rclone/fs/fspath"

	"github.com/rclone/rclone-ui/core/errs"
)

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

func CheckNewRemoteName(field, name string, existing []string) error {
	if err := CheckRemoteName(field, name); err != nil {
		return err
	}
	if slices.Contains(existing, name) {
		return errs.Field(field, "A remote called %s already exists.", name)
	}
	return nil
}

func validName(name string) bool {
	return fspath.CheckConfigName(name) == nil
}

func isASCIILetter(c byte) bool { return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' }
