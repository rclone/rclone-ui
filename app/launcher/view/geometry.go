package view

import "strings"

const (
	Width      = 700.0
	QueryH     = 56.0
	HeaderH    = 24.0
	RowH       = 48.0
	GroupH     = 24.0
	FooterH    = 30.0
	Padding    = 8.0
	Radius     = 14.0
	IconSize   = 20.0
	MaxListH   = MaxRows * RowH
	Inset      = 18.0
	FieldTop   = 14.0
	FieldW     = Width - 2*Inset
	StopSize   = 22.0
	StopMargin = 12.0
	StopLeft   = Width - StopMargin - StopSize
	LineH      = 18.0
	FooterW    = StopLeft - StopMargin - Inset
	SpinSize   = 16.0
	SpinGap    = 6.0
	StatusLeft = Inset + SpinSize + SpinGap
	Slide      = 8.0
)

func RowSpan(r Row) float64 {
	if r.Group != "" {
		return GroupH + RowH
	}
	return RowH
}

func ListH(s Snapshot) float64 {
	if s.More {
		return MaxListH
	}
	h := 0.0
	for _, r := range s.Rows {
		h += RowSpan(r)
	}
	return min(h, MaxListH)
}

func Height(s Snapshot) float64 {
	h := QueryH + ListH(s) + FooterH + Padding
	if s.Header != "" {
		h += HeaderH
	}
	return h
}

func FullHeight() float64 { return QueryH + MaxListH + FooterH + Padding }

func RowsTop(header bool) float64 {
	if header {
		return QueryH + HeaderH
	}
	return QueryH
}

func RowTop(s Snapshot, i int) float64 {
	y := RowsTop(s.Header != "")
	for j := 0; j < i && j < len(s.Rows); j++ {
		y += RowSpan(s.Rows[j])
	}
	if i < len(s.Rows) && s.Rows[i].Group != "" {
		y += GroupH
	}
	return y
}

func ListBottom(s Snapshot) float64 { return RowsTop(s.Header != "") + ListH(s) }

func RowAt(y float64, s Snapshot) int {
	if y >= ListBottom(s) {
		return -1
	}
	for i := range s.Rows {
		if top := RowTop(s, i); y >= top && y < top+RowH {
			return i
		}
	}
	return -1
}

func FooterTop(s Snapshot) float64 { return Height(s) - FooterH }

func StopTop(s Snapshot) float64 { return FooterTop(s) + LineH/2 - StopSize/2 }

func InStop(x, y float64, s Snapshot) bool {
	top := StopTop(s)
	return x >= StopLeft && x < StopLeft+StopSize && y >= top && y < top+StopSize
}

func Centred(w, h, scale float64) (dx, dy float64) {
	return (w - Width*scale) / 2, max((h-FullHeight()*scale)/2, 0)
}

func FooterText(hints []Hint) string {
	parts := make([]string, 0, len(hints))
	for _, h := range hints {
		parts = append(parts, h.Keys+" "+h.Label)
	}
	return strings.Join(parts, "     ")
}
