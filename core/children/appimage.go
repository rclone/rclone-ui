package children

import (
	"os"
	"strings"
)

// When the app runs from an AppImage, this executable lives inside the AppImage's mount and
// loads its libraries through the AppImage's LD_LIBRARY_PATH. Other programs that the core starts
// get the host's environment instead (core/internal/hostenv), because a Python password command,
// for example, fails with the AppImage's libraries. The rcui children run this same executable,
// so spawn gives them the AppImage's LD_LIBRARY_PATH back.

// AppImageLibraryPath returns the AppImage's LD_LIBRARY_PATH when this process runs from an
// AppImage ($APPIMAGE is set), and "" otherwise.
func AppImageLibraryPath() string {
	libs, ok := appImageLibraryPath(os.Environ())
	if !ok {
		return ""
	}
	return libs
}

// appImageLibraryPath returns LD_LIBRARY_PATH from env, and whether env belongs to an AppImage
// ($APPIMAGE is set).
func appImageLibraryPath(env []string) (string, bool) {
	var appImage, libs string
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "APPIMAGE="); ok {
			appImage = v
		} else if v, ok := strings.CutPrefix(kv, "LD_LIBRARY_PATH="); ok {
			libs = v
		}
	}
	return libs, appImage != ""
}

// withLibraryPath returns a rcui child's environment with LD_LIBRARY_PATH set back to the
// AppImage's value (libs), replacing any other value. When libs is "" (not an AppImage), it
// returns env unchanged.
func withLibraryPath(env []string, libs string) []string {
	if libs == "" {
		return env
	}
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, "LD_LIBRARY_PATH=") {
			out = append(out, kv)
		}
	}
	return append(out, "LD_LIBRARY_PATH="+libs)
}
