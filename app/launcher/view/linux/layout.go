package linux

// The view's arithmetic, kept apart from GTK so that it is tested on every platform.

import (
	"math"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

// topMargin returns the distance from the top of a monitor that is h tall to a centred layer
// surface. It is where a window with every row would be centred, so the window grows downward
// and never jumps.
func topMargin(h int32) int {
	_, dy := view.Centred(0, float64(h), 1)
	return int(dy)
}

// dragMargins returns the new margins of a layer surface when the pointer has moved by (dx, dy)
// since the button was pressed. The margins move by the same amount, but never past the
// monitor's top or left edge.
func dragMargins(left, top int, dx, dy float64) (int, int) {
	return max(left+int(math.Round(dx)), 0), max(top+int(math.Round(dy)), 0)
}
