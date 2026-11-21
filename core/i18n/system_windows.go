package i18n

import "golang.org/x/sys/windows"

// systemLanguages returns the user's preferred display languages, in order ("es-ES", "en-US").
func systemLanguages() []string {
	langs, err := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME)
	if err != nil {
		return nil
	}
	return langs
}
