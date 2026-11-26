package linux

import (
	"math"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

func topMargin(h int32) int {
	_, dy := view.Centred(0, float64(h), 1)
	return int(dy)
}

func dragMargins(left, top int, dx, dy float64) (int, int) {
	return max(left+int(math.Round(dx)), 0), max(top+int(math.Round(dy)), 0)
}
