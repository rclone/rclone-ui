package windows

import "strings"

// The windows whose route gives them their own shape.
const (
	// Commander opens at the size of the screen.
	Commander = "Commander"
	// Startup is the frameless startup screen, which the UI role opens itself.
	Startup = "Startup"
)

// Shape is the size and style of a route's window.
type Shape int

const (
	// Standard is 840×725 (resizable from 650×500 to 1000×1000), and cascades from the windows
	// that are already open.
	Standard Shape = iota
	// Full is the size of the screen's work area. On macOS its content extends under the title
	// bar.
	Full
	// Small is the startup screen. It is frameless, 800×500, not resizable and always on top.
	Small
)

// ForRoute returns the name of the window that a route opens in, and its shape. The name is the
// route's first segment, capitalised, or "Main" for "/". Pages compute their own name the same way
// (see windowName in lib/shell).
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
