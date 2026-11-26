package windows

// Area is a screen's work area in logical pixels.
type Area struct{ X, Y, Width, Height int }

const cascadeStep = 20

func Cascade(area Area, w, h, open int) (x, y int) {
	x = area.X + (area.Width-w)/2
	y = area.Y + (area.Height-h)/2
	offset := open * cascadeStep
	if open%2 != 0 {
		offset = -offset
	}
	x = clamp(x+offset, area.X, area.X+area.Width-w)
	y = clamp(y+offset, area.Y, area.Y+area.Height-h)
	return x, y
}

func Center(area Area, w, h int) (x, y int) {
	return Cascade(area, w, h, 0)
}

func clamp(v, lo, hi int) int {
	if hi < lo {
		return lo
	}
	return max(lo, min(v, hi))
}
