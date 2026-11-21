package view

import "strings"

// The launcher's geometry, shared by the three views. Sizes are in macOS points, which match
// device-independent pixels on Windows and logical pixels in GTK, so the launcher is the same
// size everywhere. Each view decides for itself how to lay out the contents of a row.
const (
	Width    = 700.0
	QueryH   = 56.0 // the band the query box sits in
	HeaderH  = 24.0 // the line above the rows, when there is one
	RowH     = 48.0
	GroupH   = 24.0 // a group's label, above its first row
	FooterH  = 30.0 // the hints along the bottom
	Padding  = 8.0  // beside the rows, and below the footer
	Radius   = 14.0 // the window's corners
	IconSize = 20.0 // a row's icon, square
	// MaxListH is the most height the rows can take. A longer list is cut off there, and its last
	// visible row is drawn only in part.
	MaxListH = MaxRows * RowH
	// FieldTop is the top of the query box within the query band. The box is 30 tall and FieldW
	// wide, starting 18 from the left.
	FieldTop = 14.0
	FieldW   = Width - 36
	// The stop-everything button is a StopSize square in the bottom right corner, on the footer
	// line (see StopTop).
	StopSize = 22.0
	StopLeft = Width - 12 - StopSize
	// The footer line (see FooterLine) starts 18 from the left and is FooterW wide, ending before
	// the stop button. It shows the hints or a status. A loading status starts with the spinner,
	// a SpinSize square, and its text starts at StatusLeft.
	FooterW    = StopLeft - 12 - 18
	SpinSize   = 16.0
	StatusLeft = 18 + SpinSize + 6
	// Slide is how far a footer line moves during the swap animation (see SwapFor). The old line
	// moves up and out, and the new line moves up from below into its place.
	Slide = 8.0
)

func RowSpan(r Row) float64 {
	if r.Group != "" {
		return GroupH + RowH
	}
	return RowH
}

func ListH(s Snapshot) float64 {
	if s.More {
		return MaxListH
	}
	h := 0.0
	for _, r := range s.Rows {
		h += RowSpan(r)
	}
	return min(h, MaxListH)
}

func Height(s Snapshot) float64 {
	h := QueryH + ListH(s) + FooterH + Padding
	if s.Header != "" {
		h += HeaderH
	}
	return h
}

// FullHeight returns the window height with a full list and no header.
func FullHeight() float64 { return QueryH + MaxListH + FooterH + Padding }

// RowsTop returns the top of the list, measured from the top of the window.
func RowsTop(header bool) float64 {
	if header {
		return QueryH + HeaderH
	}
	return QueryH
}

// RowTop returns the top of row i, measured from the top of the window. When the row has a group
// label, the row starts below it. A row that starts at ListBottom or lower isn't drawn, and a row
// that ends below ListBottom is cut off there.
func RowTop(s Snapshot, i int) float64 {
	y := RowsTop(s.Header != "")
	for j := 0; j < i && j < len(s.Rows); j++ {
		y += RowSpan(s.Rows[j])
	}
	if i < len(s.Rows) && s.Rows[i].Group != "" {
		y += GroupH
	}
	return y
}

// ListBottom returns the bottom of the list, measured from the top of the window. Anything below
// it is cut off.
func ListBottom(s Snapshot) float64 { return RowsTop(s.Header != "") + ListH(s) }

// RowAt returns the drawn row at height y, measured from the top of the window, or -1. A group
// label doesn't count as part of its row, and neither does the cut-off part of a row.
func RowAt(y float64, s Snapshot) int {
	if y >= ListBottom(s) {
		return -1
	}
	for i := range s.Rows {
		if top := RowTop(s, i); y >= top && y < top+RowH {
			return i
		}
	}
	return -1
}

// FooterTop returns the top of the footer line, which is 18 tall, measured from the top of the
// window.
func FooterTop(s Snapshot) float64 { return Height(s) - FooterH }

// StopTop returns the top of the stop-everything button, which is centred on the footer line.
func StopTop(s Snapshot) float64 { return FooterTop(s) + 9 - StopSize/2 }

// InStop reports whether (x, y), measured from the window's top-left corner, is on the
// stop-everything button.
func InStop(x, y float64, s Snapshot) bool {
	top := StopTop(s)
	return x >= StopLeft && x < StopLeft+StopSize && y >= top && y < top+StopSize
}

// Centred returns where to put the window's top-left corner in an area that is w by h, measured
// from the area's top-left corner. The area's units are scale times the geometry's units. The top
// is where a window with every row would be centred, so the window grows downward and never
// jumps. If the area is too short for that, the window goes at the top.
func Centred(w, h, scale float64) (dx, dy float64) {
	return (w - Width*scale) / 2, max((h-FullHeight()*scale)/2, 0)
}

func FooterText(hints []Hint) string {
	parts := make([]string, 0, len(hints))
	for _, h := range hints {
		parts = append(parts, h.Keys+" "+h.Label)
	}
	return strings.Join(parts, "     ")
}
