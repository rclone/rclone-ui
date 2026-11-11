package rclone

import (
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/rc"
)

// Stats holds the parts of an rclone stats result (core/stats) that StatsInfo's getters don't
// provide: the totals, the speed, the eta and the files in progress. rclone builds that result
// by hand as rc.Params in accounting.StatsInfo.RemoteStats. The transfers read it in this
// process (ReadStats), and a child's rc response decodes into it as JSON. TestStatsAreRclones
// checks that the keys match rclone's.
type Stats struct {
	TotalBytes     int64           `json:"totalBytes"`
	TotalTransfers int64           `json:"totalTransfers"`
	Listed         int64           `json:"listed"`
	Speed          float64         `json:"speed"`
	Eta            *float64        `json:"eta"` // seconds; null when unknown
	Checking       []string        `json:"checking"`
	Transferring   []StatsTransfer `json:"transferring"`
}

// StatsTransfer is a file in progress in a stats result.
type StatsTransfer struct {
	Name       string  `json:"name"`
	Size       int64   `json:"size"`
	Bytes      int64   `json:"bytes"`
	Percentage int     `json:"percentage"`
	Speed      float64 `json:"speed"`
}

// StatsOf returns the stats result as a typed value. When short is true, it leaves out the
// files in progress.
func StatsOf(stats *accounting.StatsInfo, short bool) Stats {
	out, _ := stats.RemoteStats(short) // never fails
	return ReadStats(out)
}

// ReadStats reads an rclone stats result. rc.Reshape converts through JSON, just as rclone's rc
// serves it. A value whose type differs from rclone's stays zero.
func ReadStats(out rc.Params) Stats {
	var st Stats
	_ = rc.Reshape(&st, out)
	return st
}
