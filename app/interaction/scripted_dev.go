//go:build !production

package interaction

// Scripted, when set, answers every dialog instead of the user. Development runs that are driven
// by scripts use it (see devEval in package app). prompt is true when text is asked for, and text
// is the answer to the prompt. A release build has no Scripted.
var Scripted func(d Dialog, prompt bool) (a Answer, text string)

// scripted returns the script's answer to d, and false when no script answers.
func scripted(d Dialog, prompt bool) (Answer, string, bool) {
	if Scripted == nil {
		return 0, "", false
	}
	a, text := Scripted(d, prompt)
	return a, text, true
}
