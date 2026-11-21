package i18n

import (
	"os/exec"
	"regexp"
)

// quoted finds the languages in the output of `defaults read -g AppleLanguages`, which is a
// list such as ("en-US", "zh-Hans-US").
var quoted = regexp.MustCompile(`"([^"]+)"`)

// systemLanguages returns the user's preferred languages, in order, from System Settings. A GUI
// app on macOS has no LANG to read.
func systemLanguages() []string {
	out, err := exec.Command("/usr/bin/defaults", "read", "-g", "AppleLanguages").Output()
	if err != nil {
		return nil
	}
	var langs []string
	for _, m := range quoted.FindAllSubmatch(out, -1) {
		langs = append(langs, string(m[1]))
	}
	return langs
}
