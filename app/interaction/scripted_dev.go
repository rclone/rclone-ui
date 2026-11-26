//go:build !production

package interaction

var Scripted func(d Dialog, prompt bool) (a Answer, text string)

func scripted(d Dialog, prompt bool) (Answer, string, bool) {
	if Scripted == nil {
		return 0, "", false
	}
	a, text := Scripted(d, prompt)
	return a, text, true
}
