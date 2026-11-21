//go:build production

package interaction

func scripted(Dialog, bool) (Answer, string, bool) { return 0, "", false }
