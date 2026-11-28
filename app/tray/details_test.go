package tray

import "testing"

func TestTransferDetailSlots(t *testing.T) {
	clicked := 0
	before := detailItems(TransferDetails{Summary: "Summary", Files: []TransferFile{{Label: "one · 20%", Path: "a/one"}}, More: 3}, func() { clicked++ })
	after := detailItems(TransferDetails{Summary: "Summary · 50%"}, nil)
	if len(before) != MaxTransferFiles+2 || len(after) != len(before) {
		t.Fatal("changing progress changed menu structure")
	}
	if !before[0].Disabled || before[0].Hidden || before[1].Hidden || before[1].Tooltip != "a/one" || !before[2].Hidden || before[len(before)-1].Hidden {
		t.Fatalf("bad slots %+v", before)
	}
	for _, it := range after[1:] {
		if !it.Hidden {
			t.Fatal("stale file or overflow row")
		}
	}
	before[1].OnClick()
	before[len(before)-1].OnClick()
	if clicked != 2 {
		t.Fatal("files must open History")
	}
}

func TestTransferDetailsMenu(t *testing.T) {
	s := state{transfers: "History (1 running)", details: TransferDetails{Summary: "Transfers (1)", Files: []TransferFile{{Label: "one"}}}}
	items, history := layout(s, Actions{})
	if history != 2 || !items[3].detailSlots || items[3].Label != "Transfers" || len(items[3].Children) != MaxTransferFiles+2 {
		t.Fatalf("details missing: %+v", items)
	}
	s.transfers = ""
	items, _ = layout(s, Actions{})
	for _, it := range items {
		if it.detailSlots {
			t.Fatal("details visible after transfers ended")
		}
	}
}
