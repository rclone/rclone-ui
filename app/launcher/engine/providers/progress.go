package providers

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/core/i18n"
)

func progressLine(p corestate.Sum) string {
	var parts []string
	if p.Pct >= 0 {
		parts = append(parts, fmt.Sprintf("%d%%", p.Pct))
	}
	if p.Speed >= 1 {
		parts = append(parts, Size(int64(p.Speed))+"/s")
	}
	if p.Left > 0 {
		parts = append(parts, left(p.Left))
	}
	return strings.Join(parts, " · ")
}

func Size(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	v, i := float64(n)/unit, 0
	for v >= unit && i < 3 {
		v /= unit
		i++
	}
	suffix := []string{"KB", "MB", "GB", "TB"}[i]
	if v < 10 {
		return strings.TrimSuffix(fmt.Sprintf("%.1f", v), ".0") + " " + suffix
	}
	return fmt.Sprintf("%.0f %s", v, suffix)
}

func left(d time.Duration) string {
	if d < time.Minute {
		return i18n.T("less than a minute left")
	}
	mins := int(math.Ceil(d.Minutes()))
	if mins < 60 {
		// i18n: The time a transfer has left, in minutes.
		return i18n.N("%d min left", "%d min left", mins, mins)
	}
	if h := mins / 60; mins%60 == 0 {
		// i18n: The time a transfer has left, in hours.
		return i18n.N("%d h left", "%d h left", h, h)
	}
	// i18n: The time a transfer has left, in hours (%[1]d) and minutes (%[2]d).
	return i18n.T("%[1]d h %[2]d min left", mins/60, mins%60)
}

func ago(t, now time.Time) string {
	switch d := now.Sub(t); {
	case d < time.Minute:
		return i18n.T("just now")
	case d < time.Hour:
		m := int(d.Minutes())
		return i18n.N("%d min ago", "%d min ago", m, m)
	default:
		h := int(d.Hours())
		return i18n.N("%d h ago", "%d h ago", h, h)
	}
}
