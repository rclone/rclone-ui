package windows

import "strings"

const (
	Commander = "Commander"
	Startup   = "Startup"
)

type Shape int

const (
	Standard Shape = iota
	Full
	Small
)

func ForRoute(url string) (name string, shape Shape) {
	path, _, _ := strings.Cut(url, "?")
	segment := ""
	for s := range strings.SplitSeq(path, "/") {
		if s != "" {
			segment = s
			break
		}
	}
	if segment == "" {
		return "Main", Standard
	}
	name = strings.ToUpper(segment[:1]) + segment[1:]
	switch name {
	case Commander:
		return name, Full
	case Startup:
		return name, Small
	}
	return name, Standard
}
