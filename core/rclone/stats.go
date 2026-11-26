package rclone

import (
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/rc"
)

type Stats struct {
	TotalBytes     int64           `json:"totalBytes"`
	TotalTransfers int64           `json:"totalTransfers"`
	Listed         int64           `json:"listed"`
	Speed          float64         `json:"speed"`
	ETASeconds     *float64        `json:"eta"`
	Checking       []string        `json:"checking"`
	Transferring   []StatsTransfer `json:"transferring"`
}

type StatsTransfer struct {
	Name       string  `json:"name"`
	Size       int64   `json:"size"`
	Bytes      int64   `json:"bytes"`
	Percentage int     `json:"percentage"`
	Speed      float64 `json:"speed"`
}

func StatsOf(stats *accounting.StatsInfo, short bool) Stats {
	out, _ := stats.RemoteStats(short)
	return ReadStats(out)
}

func ReadStats(out rc.Params) Stats {
	var st Stats
	_ = rc.Reshape(&st, out)
	return st
}
