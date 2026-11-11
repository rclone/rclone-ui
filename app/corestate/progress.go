package corestate

import (
	"time"

	"github.com/rclone/rclone-ui/core/bus"
)

// Sum is the combined progress of the running transfers.
type Sum struct {
	// Running is how many transfers have progress.
	Running int
	// Pct is the percentage of their bytes done, or -1 while none of them knows its total.
	Pct int
	// Speed is their combined speed in bytes per second.
	Speed float64
	// Left is the time until the last of them ends, or 0 while any of them can't tell.
	Left time.Duration
}

func SumProgress(ps []*bus.TransferProgress) Sum {
	out := Sum{Pct: -1}
	var done, total, eta int64
	known := true
	for _, p := range ps {
		if p == nil {
			continue
		}
		out.Running++
		done += p.Bytes
		total += p.TotalBytes
		out.Speed += p.Speed
		if p.Eta != nil {
			eta = max(eta, *p.Eta)
		} else {
			known = false
		}
	}
	if total > 0 {
		out.Pct = int(min(done*100/total, 100))
	}
	if out.Running > 0 && known {
		out.Left = time.Duration(eta) * time.Second
	}
	return out
}
