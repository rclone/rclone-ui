package pathlink

import "strings"

// These functions work on a Windows PATH value as stored in HKCU\Environment. Folders are
// separated by ';' and compared ignoring case and a trailing backslash. They are plain string
// functions, so their tests run on every OS.

func pathHas(value, dir string) bool {
	for seg := range strings.SplitSeq(value, ";") {
		if samePathSegment(seg, dir) {
			return true
		}
	}
	return false
}

// pathWith returns the value with dir appended, unless it already lists dir.
func pathWith(value, dir string) string {
	if pathHas(value, dir) {
		return value
	}
	segs := nonEmpty(strings.Split(value, ";"))
	return strings.Join(append(segs, dir), ";")
}

// pathWithout returns the value with every occurrence of dir removed.
func pathWithout(value, dir string) string {
	var out []string
	for _, seg := range nonEmpty(strings.Split(value, ";")) {
		if !samePathSegment(seg, dir) {
			out = append(out, seg)
		}
	}
	return strings.Join(out, ";")
}

func samePathSegment(seg, dir string) bool {
	norm := func(s string) string { return strings.ToLower(strings.TrimRight(strings.TrimSpace(s), `\`)) }
	return dir != "" && norm(seg) == norm(dir)
}

func nonEmpty(segs []string) []string {
	out := segs[:0:0]
	for _, s := range segs {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}
