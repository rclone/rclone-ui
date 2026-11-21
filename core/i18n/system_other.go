//go:build !darwin && !windows

package i18n

import (
	"os"
	"strings"
)

// systemLanguages returns the user's preferred languages from the environment, as gettext reads
// it: LANGUAGE is a list in order ("es:en"), then LC_ALL, LC_MESSAGES and LANG ("es_ES.UTF-8").
func systemLanguages() []string {
	var langs []string
	if list := os.Getenv("LANGUAGE"); list != "" {
		langs = strings.Split(list, ":")
	}
	for _, name := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if v := os.Getenv(name); v != "" {
			langs = append(langs, v)
			break
		}
	}
	return langs
}
