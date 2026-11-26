package pathlink

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/rclone/rclone-ui/core/i18n"
)

type Linker struct {
	exe         string
	link        string
	pointer     string
	unsupported i18n.Text
	command     string
	path        func() []string
	asAdmin     func(shellCmd, prompt string) error
	userPath    store
}

type store interface {
	get() (value string, err error)
	set(value string) error
}

func New() (*Linker, error) { return newLinker() }

func envPath() []string { return filepath.SplitList(os.Getenv("PATH")) }

func indexOf(dirs []string, dir string, fold bool) int {
	want := filepath.Clean(dir)
	for i, d := range dirs {
		if d == "" {
			continue
		}
		d = filepath.Clean(d)
		if d == want || (fold && strings.EqualFold(d, want)) {
			return i
		}
		if r, err := filepath.EvalSymlinks(d); err == nil && r == want {
			return i
		}
	}
	return -1
}

func warning(linkDir string, onPath bool, user string, userFirst bool) string {
	switch {
	case !onPath:
		// i18n: %s is a folder. A login shell is a terminal session that reads the user's profile.
		return i18n.T("%s isn't on your PATH yet: add it, or open a new login shell.", linkDir)
	case user != "" && userFirst:
		// i18n: %s is the path of another rclone program.
		return i18n.T("Another rclone, at %s, comes first on your PATH: `rclone` in a terminal runs that one.", user)
	case user != "":
		// i18n: %s is the path of another rclone program.
		return i18n.T("`rclone` in a terminal now runs Rclone UI's rclone, not the one at %s.", user)
	}
	return ""
}
