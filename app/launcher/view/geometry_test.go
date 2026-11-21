package view

import "testing"

func rows(n int) []Row { return make([]Row, n) }

func TestHeightAndRows(t *testing.T) {
	if got := Height(Snapshot{}); got != 94 {
		t.Errorf("Height(none) = %v", got)
	}
	if got := Height(Snapshot{Header: "x", Rows: rows(2)}); got != QueryH+HeaderH+2*RowH+FooterH+Padding {
		t.Errorf("Height(2, header) = %v", got)
	}
	if got := Height(Snapshot{Header: "x", Rows: rows(MaxRows)}); got != 56+24+8*48+30+8 {
		t.Errorf("full height %v", got)
	}
	if FullHeight() != Height(Snapshot{Rows: rows(MaxRows)}) {
		t.Errorf("FullHeight %v", FullHeight())
	}
	for _, c := range []struct {
		y      float64
		rows   int
		header bool
		want   int
	}{
		{10, 3, false, -1},
		{QueryH - 1, 3, false, -1},
		{QueryH, 3, false, 0},
		{QueryH + RowH - 1, 3, false, 0},
		{QueryH + RowH, 3, false, 1},
		{QueryH + 3*RowH, 3, false, -1}, // the footer
		{QueryH + 10, 3, true, -1},      // the header line
		{QueryH + HeaderH, 3, true, 0},
	} {
		s := Snapshot{Rows: rows(c.rows)}
		if c.header {
			s.Header = "x"
		}
		if got := RowAt(c.y, s); got != c.want {
			t.Errorf("RowAt(%v, %d, %v) = %d, want %d", c.y, c.rows, c.header, got, c.want)
		}
	}
	if RowsTop(false) != QueryH || RowsTop(true) != QueryH+HeaderH {
		t.Error("RowsTop")
	}
	if FieldTop+30 > QueryH || 18+FieldW > Width {
		t.Errorf("field at %v, %v wide", FieldTop, FieldW)
	}
	for _, s := range []Snapshot{{}, {Header: "x", Rows: rows(3)}, {Rows: rows(1), More: true}} {
		top := StopTop(s)
		if top < ListBottom(s) || top+StopSize > Height(s) || StopLeft+StopSize > Width {
			t.Errorf("stop button at %v, %v in %v (rows end %v)", StopLeft, top, Height(s), ListBottom(s))
		}
		if !InStop(StopLeft+1, top+1, s) || InStop(StopLeft-1, top+1, s) || InStop(StopLeft+1, top+StopSize, s) {
			t.Error("InStop")
		}
	}
}

func TestGroupLabels(t *testing.T) {
	s := Snapshot{Rows: []Row{{Group: "Active"}, {}, {Group: "Operations"}}}
	if got := ListH(s); got != 3*RowH+2*GroupH {
		t.Errorf("ListH = %v", got)
	}
	if RowTop(s, 0) != QueryH+GroupH || RowTop(s, 1) != QueryH+GroupH+RowH || RowTop(s, 2) != QueryH+2*GroupH+2*RowH {
		t.Errorf("RowTop: %v %v %v", RowTop(s, 0), RowTop(s, 1), RowTop(s, 2))
	}
	for _, c := range []struct {
		y    float64
		want int
	}{
		{QueryH + 1, -1}, // the first label
		{QueryH + GroupH, 0},
		{QueryH + GroupH + RowH, 1},
		{QueryH + GroupH + 2*RowH + 1, -1}, // the second label
		{QueryH + 2*GroupH + 2*RowH, 2},
	} {
		if got := RowAt(c.y, s); got != c.want {
			t.Errorf("RowAt(%v) = %d, want %d", c.y, got, c.want)
		}
	}
	// Eight rows and a label: the eighth row is cut off, and the list is MaxListH tall no matter
	// what is drawn.
	long := Snapshot{Rows: append([]Row{{Group: "Active"}}, rows(7)...), More: true}
	if ListH(long) != MaxListH || Height(long) != FullHeight() {
		t.Errorf("a longer list: ListH %v, Height %v", ListH(long), Height(long))
	}
	last := RowTop(long, 7)
	if last >= ListBottom(long) || last+RowH <= ListBottom(long) {
		t.Fatalf("the last row at %v, the list ending at %v", last, ListBottom(long))
	}
	if RowAt(last+1, long) != 7 || RowAt(ListBottom(long), long) != -1 {
		t.Error("the cut row: its part drawn is there, the rest isn't")
	}
}

func TestCentred(t *testing.T) {
	full := FullHeight()
	for _, c := range []struct {
		w, h, scale float64
		dx, dy      float64
	}{
		{1920, 1000, 1, (1920 - 700) / 2, (1000 - full) / 2},
		{1920, 1048, 1, 610, (1048 - full) / 2},
		{2560, 1400, 1.5, (2560 - 1050) / 2, (1400 - 1.5*full) / 2}, // 150%: 1050 pixels wide
		{1920, 300, 1, 610, 0},                                      // too short, so at the top
	} {
		dx, dy := Centred(c.w, c.h, c.scale)
		if dx != c.dx || dy != c.dy {
			t.Errorf("Centred(%v, %v, %v) = %v, %v; want %v, %v", c.w, c.h, c.scale, dx, dy, c.dx, c.dy)
		}
	}
}

func TestFooterText(t *testing.T) {
	got := FooterText([]Hint{{Keys: "⏎", Label: "Open"}, {Keys: "Ctrl+K", Label: "Actions"}})
	if got != "⏎ Open     Ctrl+K Actions" {
		t.Errorf("footer %q", got)
	}
	if got := FooterText(nil); got != "" {
		t.Errorf("no hints: %q", got)
	}
}

func TestFooterLine(t *testing.T) {
	hints := Snapshot{Footer: []Hint{{Keys: "⏎", Label: "Open"}}}
	working := Snapshot{Footer: hints.Footer, Status: Status{Kind: StatusLoading, Text: "Unmounting…"}}
	done := Snapshot{Footer: hints.Footer, Status: Status{Kind: StatusDone, Text: "Unmounted."}}
	if l := FooterLine(hints); l.Hints != "⏎ Open" || l.Status.Kind != StatusNone {
		t.Errorf("hints: %+v", l)
	}
	if l := FooterLine(working); l.Hints != "" || l.Status != working.Status {
		t.Errorf("a status: %+v", l)
	}
	other := Snapshot{Footer: []Hint{{Keys: "⏎", Label: "Browse"}}}
	for _, c := range []struct {
		from, to Snapshot
		swaps    bool
	}{
		{hints, working, true},
		{working, done, true},
		{done, hints, true},
		{hints, other, false},
		{working, working, false},
	} {
		if got := Swaps(FooterLine(c.from), FooterLine(c.to)); got != c.swaps {
			t.Errorf("Swaps(%+v, %+v) = %v", FooterLine(c.from), FooterLine(c.to), got)
		}
	}
	if StatusLeft+100 > 18+FooterW || 18+FooterW > StopLeft {
		t.Errorf("footer line %v wide, status text at %v, stop button at %v", FooterW, StatusLeft, StopLeft)
	}
}
