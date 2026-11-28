package tray

import (
	"fmt"
	"github.com/rclone/rclone-ui/core/i18n"
)

// MaxTransferFiles bounds the number of live files shown in the native menu.
const MaxTransferFiles = 5

// TransferFile is one live file's compact label and full path for its tooltip.
type TransferFile struct {
	Label string
	Path  string
}

// TransferDetails is the read-only progress shown below History. More counts files
// beyond the visible rows. An empty Summary removes the details submenu.
type TransferDetails struct {
	Summary string
	Files   []TransferFile
	More    int
}

// detailItems keeps a fixed set of rows so a progress tick never replaces an open
// menu. Unused file rows and the overflow link are hidden, not removed.
func detailItems(d TransferDetails, open func()) []Item {
	items := []Item{{Label: d.Summary, Disabled: true}}
	for i := 0; i < MaxTransferFiles; i++ {
		row := Item{Hidden: true, OnClick: open}
		if i < len(d.Files) {
			row.Label = d.Files[i].Label
			row.Tooltip = d.Files[i].Path
			row.Hidden = false
		}
		items = append(items, row)
	}
	items = append(items, Item{Label: fmt.Sprintf("%s (+%d)", i18n.T("History"), d.More), Hidden: d.More <= 0, OnClick: open})
	return items
}
