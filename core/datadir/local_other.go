//go:build !darwin && !windows

package datadir

import (
	"os"
	"path/filepath"
)

// localDataDir returns $XDG_DATA_HOME when it is an absolute path, or else ~/.local/share. A
// relative value is ignored, as the XDG spec says.
func localDataDir() (string, error) {
	if xdg := os.Getenv("XDG_DATA_HOME"); filepath.IsAbs(xdg) {
		return xdg, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share"), nil
}
