//go:build !darwin && !linux && !windows

package pathlink

import "github.com/rclone/rclone-ui/core/i18n"

func newLinker() (*Linker, error) {
	return &Linker{path: envPath, unsupported: i18n.M("Rclone UI doesn't add rclone to PATH on this system.")}, nil
}
