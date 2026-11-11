package windows

import (
	"reflect"
	"testing"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

func TestKeyFor(t *testing.T) {
	for _, c := range []struct {
		vk               uint32
		ctrl, shift, alt bool
		want             view.KeyEvent
		ok               bool
	}{
		{vkEscape, false, false, false, view.KeyEvent{Key: view.KeyEsc}, true},
		{vkReturn, false, false, false, view.KeyEvent{Key: view.KeyEnter}, true},
		{vkUp, false, false, false, view.KeyEvent{Key: view.KeyUp}, true},
		{vkDown, false, false, false, view.KeyEvent{Key: view.KeyDown}, true},
		{vkTab, false, false, false, view.KeyEvent{Key: view.KeyTab}, true},
		{vkTab, false, true, false, view.KeyEvent{}, false}, // shift-tab
		{'K', true, false, false, view.KeyEvent{Key: view.KeyActions}, true},
		{'3', true, false, false, view.KeyEvent{Key: view.KeyRow, Char: '3'}, true},
		{'B', true, false, false, view.KeyEvent{Key: view.KeyRow, Char: 'b'}, true},
		{'B', false, false, false, view.KeyEvent{}, false}, // typing
		{'Q', true, false, true, view.KeyEvent{}, false},   // AltGr+Q types @
		{0x70, true, false, false, view.KeyEvent{}, false}, // Ctrl+F1
		// Ctrl+. stops everything. A . alone, or with AltGr, is typed.
		{vkPeriod, true, false, false, view.KeyEvent{Key: view.KeyRow, Char: '.'}, true},
		{vkPeriod, false, false, false, view.KeyEvent{}, false},
		{vkPeriod, true, false, true, view.KeyEvent{}, false},
	} {
		got, ok := keyFor(c.vk, c.ctrl, c.shift, c.alt)
		if ok != c.ok || got != c.want {
			t.Errorf("keyFor(%#x, ctrl=%v shift=%v alt=%v) = %+v, %v", c.vk, c.ctrl, c.shift, c.alt, got, ok)
		}
	}
}

func TestBoldRanges(t *testing.T) {
	for _, c := range []struct {
		s    string
		bold []int
		want []textRange
	}{
		{"Move", nil, nil},
		{"Move", []int{0, 1}, []textRange{{0, 2}}},
		{"Show Remotes", []int{7, 8, 5}, []textRange{{5, 1}, {7, 2}}},
		// 😀 is two UTF-16 units, so the runes after it are shifted by one
		{"😀 docs", []int{0, 2, 3}, []textRange{{0, 2}, {3, 2}}},
		{"ab", []int{5, -1, 1, 1}, []textRange{{1, 1}}},
	} {
		if got := boldRanges(c.s, c.bold); !reflect.DeepEqual(got, c.want) {
			t.Errorf("boldRanges(%q, %v) = %v, want %v", c.s, c.bold, got, c.want)
		}
	}
	if got := (textRange{start: 3, length: 2}).packed(); got != 3|2<<32 {
		t.Fatalf("packed = %#x", got)
	}
}

func TestWordStart(t *testing.T) {
	text := utf16.Encode([]rune("copy gdrive:  "))
	for _, c := range []struct{ caret, want int }{
		{len(text), 5}, // skips the spaces, then the word
		{4, 0},
		{5, 0},
		{0, 0},
		{99, 5},
	} {
		if got := wordStart(text, c.caret); got != c.want {
			t.Errorf("wordStart(%d) = %d, want %d", c.caret, got, c.want)
		}
	}
}

func TestBlurDue(t *testing.T) {
	for _, c := range []struct {
		down, over bool
		up         time.Duration
		want       bool
	}{
		{true, true, 0, false},
		{true, false, time.Hour, false}, // still down, so a drag may come back
		{false, false, 0, true},
		{false, true, 0, false},
		{false, true, dropGrace - time.Millisecond, false},
		{false, true, dropGrace, true},
	} {
		if got := blurDue(c.down, c.over, c.up); got != c.want {
			t.Errorf("blurDue(down=%v, over=%v, %v) = %v", c.down, c.over, c.up, got)
		}
	}
}

// TestLayoutCache checks that a layout which a full frame doesn't draw is released at the next
// frame, and created again if it comes back.
func TestLayoutCache(t *testing.T) {
	var made, released []uintptr
	next := uintptr(0)
	build := func() uintptr { next++; made = append(made, next); return next }
	c := layoutCache{release: func(l uintptr) { released = append(released, l) }}
	a, b := newTextKey(1, "a", 10, 16, nil), newTextKey(1, "b", 10, 16, []textRange{{0, 1}})
	if newTextKey(1, "b", 10, 16, nil) == b || newTextKey(2, "b", 10, 16, []textRange{{0, 1}}) == b {
		t.Fatal("keys of different layouts are equal")
	}

	c.frame()
	la, lb := c.get(a, build), c.get(b, build)
	if c.get(a, build) != la || len(made) != 2 {
		t.Fatalf("made %v", made)
	}
	c.frame() // draws a only
	if c.get(a, build) != la || len(released) != 0 {
		t.Fatalf("a: made %v, released %v", made, released)
	}
	c.frame() // b wasn't drawn for a full frame
	if len(released) != 1 || released[0] != lb {
		t.Fatalf("released %v, want [%d]", released, lb)
	}
	if c.get(b, build) == lb || len(made) != 3 {
		t.Fatalf("b again: made %v", made)
	}
	x := newTextKey(1, "x", 1, 1, nil)
	if c.get(x, func() uintptr { return 0 }) != 0 {
		t.Fatal("a failed layout")
	}
	if _, kept := c.cur[x]; kept {
		t.Fatal("a failed layout is kept")
	}
}

func TestSwapProgress(t *testing.T) {
	for _, c := range []struct {
		elapsed time.Duration
		want    float32
	}{
		{-time.Millisecond, 0},
		{0, 0},
		{view.SwapFor / 2, 0.875},
		{view.SwapFor, 1},
		{2 * view.SwapFor, 1},
	} {
		if got := swapProgress(c.elapsed); got != c.want {
			t.Errorf("swapProgress(%v) = %v, want %v", c.elapsed, got, c.want)
		}
	}
}

func TestSpinnerDot(t *testing.T) {
	if x, y := spinnerDot(0); x > 1e-5 || x < -1e-5 || y != -6 {
		t.Fatalf("dot 0 at %v, %v", x, y)
	}
	if x, y := spinnerDot(2); x != 6 || y > 1e-5 || y < -1e-5 {
		t.Fatalf("dot 2 at %v, %v", x, y)
	}
}

func TestAnnouncement(t *testing.T) {
	s := view.Snapshot{Rows: []view.Row{
		{Title: "Move", Subtitle: "Move files from a source to a destination"},
		{Title: "gdrive:Photos", Tail: "/Volumes/Photos"},
		{Group: "Running", Title: "Copy", Tail: "40%"},
	}}
	for _, c := range []struct {
		selected int
		want     string
	}{
		{0, "Move, Move files from a source to a destination"},
		{1, "gdrive:Photos, /Volumes/Photos"},
		{2, "Running, Copy, 40%"},
		{-1, ""},
		{3, ""},
	} {
		s.Selected = c.selected
		if got := announcement(s); got != c.want {
			t.Errorf("selected %d: got %q, want %q", c.selected, got, c.want)
		}
	}
}

// TestColorRef checks GDI's byte order, which is blue, green, red.
func TestColorRef(t *testing.T) {
	if got := colorRef(colorF{1, 0, 0, 1}); got != 0x0000ff {
		t.Errorf("red: %#06x", got)
	}
	if got := colorRef(paletteFor(true).surface); got != 0x202020 {
		t.Errorf("dark surface: %#06x", got)
	}
	if got := colorRef(paletteFor(false).surface); got != 0xf9f9f9 {
		t.Errorf("light surface: %#06x", got)
	}
}

func TestPalette(t *testing.T) {
	for _, c := range []struct {
		dark              bool
		critical, success string
	}{
		{false, "#c42b1c", "#0f7b0f"},
		{true, "#ff99a4", "#6ccb5f"},
	} {
		p := paletteFor(c.dark)
		if got := hex(p.critical); got != c.critical {
			t.Errorf("dark=%v critical %s", c.dark, got)
		}
		if got := hex(p.success); got != c.success {
			t.Errorf("dark=%v success %s", c.dark, got)
		}
		if got := hex(p.danger); got != "#c42b1c" || p.danger.A != 1 {
			t.Errorf("dark=%v danger %s", c.dark, got)
		}
	}
}

func TestVariantLayout(t *testing.T) {
	var v variant
	if s, o := unsafe.Sizeof(v), unsafe.Offsetof(v.Val); s != 24 || o != 8 {
		t.Fatalf("size %d, value at %d", s, o)
	}
}

func TestAligned16(t *testing.T) {
	for i := range 32 {
		v := variant{VT: 3, Val: int32(i)}
		p := aligned16(v)
		if uintptr(unsafe.Pointer(p))%16 != 0 || *p != v {
			t.Fatalf("copy %d at %p: %+v", i, p, *p)
		}
		var g [16]byte
		g[0] = byte(i)
		if q := aligned16(g); uintptr(unsafe.Pointer(q))%16 != 0 || *q != g {
			t.Fatalf("guid copy %d at %p", i, q)
		}
	}
}
