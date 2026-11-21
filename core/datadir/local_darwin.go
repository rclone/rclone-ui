package datadir

import (
	"os"
	"path/filepath"
)

func localDataDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "Application Support"), nil
}
