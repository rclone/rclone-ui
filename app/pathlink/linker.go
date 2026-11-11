package pathlink

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/rclone/rclone-ui/core/i18n"
)

// Linker manages the rclone link for one copy of the app. New makes the real one, and the tests
// build their own around temporary folders.
type Linker struct {
	// exe is the program that `rclone` runs: rcui, or $APPIMAGE, which runs rcui.
	exe string
	// link is the command's path on PATH (macOS, Linux), or the folder added to PATH (Windows).
	link string
	// pointer is <data>/bin/rclone, the link's target, which points to exe (macOS, Linux).
	pointer string
	// unsupported explains why no link can work here. It is the zero Text when a link can work.
	unsupported i18n.Text
	// command is State.Command for systems where no link can work and exe isn't useful to show
	// (Flatpak).
	command string
	// path lists PATH's folders in the order a new terminal searches them.
	path func() []string
	// asAdmin runs a shell command through an administrator prompt (macOS). It is nil elsewhere.
	asAdmin func(shellCmd, prompt string) error
	// userPath is the user's stored PATH (Windows).
	userPath store
}

// store reads and writes the user's stored PATH (HKCU\Environment on Windows).
type store interface {
	get() (value string, err error)
	set(value string) error
}

func New() (*Linker, error) { return newLinker() }

// envPath returns the process's PATH. The UI role runs with the login shell's PATH (see
// platform.FixPath), so it matches the PATH that a new terminal gets.
func envPath() []string { return filepath.SplitList(os.Getenv("PATH")) }

// indexOf returns dir's position in dirs, or -1. It compares cleaned paths, ignoring case when
// fold is set.
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

// warning returns State.Warning for an enabled link.
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
