package app

import (
	"fmt"
	"math"
	"path"
	"slices"
	"strings"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/launcher/engine/providers"
	"github.com/rclone/rclone-ui/app/tray"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/i18n"
)

// trayTransferDetails uses the same live snapshot and watcher exclusion as History.
// Sorting by transfer ID and path keeps rows stable while progress events arrive.
func trayTransferDetails(live map[string]bus.TransferProgress) tray.TransferDetails {
	ids := make([]string, 0, len(live))
	for id, p := range live {
		if !p.Watcher {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	if len(ids) == 0 {
		return tray.TransferDetails{}
	}
	ps := make([]*bus.TransferProgress, 0, len(ids))
	var files []tray.TransferFile
	for _, id := range ids {
		p := live[id]
		ps = append(ps, &p)
		active := slices.Clone(p.Transferring)
		slices.SortStableFunc(active, func(a, b bus.TransferringFile) int { return strings.Compare(a.Name, b.Name) })
		for _, f := range active {
			name := strings.ReplaceAll(f.Name, "\\", "/")
			parts := []string{compactTrayName(path.Base(name))}
			if f.Size > 0 {
				parts = append(parts, fmt.Sprintf("%.0f%%", min(100, math.Floor(100*float64(max(0, f.Bytes))/float64(f.Size)))))
			}
			if f.Speed >= 1 && !math.IsInf(f.Speed, 0) && !math.IsNaN(f.Speed) {
				parts = append(parts, providers.Size(int64(f.Speed))+"/s")
			}
			files = append(files, tray.TransferFile{Label: strings.Join(parts, " · "), Path: f.Name})
		}
	}
	summary := fmt.Sprintf("%s (%d)", i18n.T("Transfers"), len(ids))
	if line := providers.ProgressLine(corestate.SumProgress(ps)); line != "" {
		summary += " · " + line
	}
	more := max(0, len(files)-tray.MaxTransferFiles)
	if len(files) > tray.MaxTransferFiles {
		files = files[:tray.MaxTransferFiles]
	}
	return tray.TransferDetails{Summary: summary, Files: files, More: more}
}

func compactTrayName(name string) string {
	// Keep a single bounded native menu row; the tooltip retains the complete path.
	name = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, name)
	runes := []rune(name)
	if len(runes) > 48 {
		return string(runes[:28]) + "…" + string(runes[len(runes)-19:])
	}
	return name
}
