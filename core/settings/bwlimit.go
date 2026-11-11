package settings

import (
	"strings"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/errs"
)

// badBwLimit is the error for a bandwidth limit that rclone can't read, or a timetable, which the
// app can't change while it runs.
const badBwLimit = "Use a speed such as 10M (10 MiB/s), or an upload and a download speed such as 10M:2M."

// BwLimit reads a bandwidth limit as rclone's --bwlimit does: one speed for both directions
// ("10M"), or an upload and a download speed ("10M:2M"). "" and "off" mean no limit. A timetable
// ("08:00,512k 19:00,off") is refused, because rclone can only change a single limit while it
// runs.
func BwLimit(s string) (fs.BwPair, error) {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "off") {
		return fs.BwPair{Tx: -1, Rx: -1}, nil
	}
	var tt fs.BwTimetable
	if err := tt.Set(s); err != nil || len(tt) != 1 || strings.ContainsAny(s, ", ") {
		return fs.BwPair{}, invalid(errs.Field("transfers.bw_limit", badBwLimit))
	}
	return tt[0].Bandwidth, nil
}
