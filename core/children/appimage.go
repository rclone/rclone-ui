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

func AppImageLibraryPath() string {
	libs, ok := appImageLibraryPath(os.Environ())
	if !ok {
		return ""
	}
	return libs
}

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
