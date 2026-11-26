package pathlink

import "strings"

func pathHas(value, dir string) bool {
	for seg := range strings.SplitSeq(value, ";") {
		if samePathSegment(seg, dir) {
			return true
		}
	}
	return false
}

func pathWith(value, dir string) string {
	if pathHas(value, dir) {
		return value
	}
	segs := nonEmpty(strings.Split(value, ";"))
	return strings.Join(append(segs, dir), ";")
}

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
