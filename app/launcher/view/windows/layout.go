// Package windows is the launcher window on Windows, written in Go on top of Win32. The window is
// borderless but keeps DWM's frame, so it gets the shadow, the rounded corners of Windows 11 and,
// from 22H2, the acrylic backdrop behind the rows. A native EDIT control handles typing and input
// methods. It sits on an opaque band, because GDI can't draw dark text on glass. Direct2D and
// DirectWrite draw the rows and the icons. A live region announces the selected row to screen
// readers.
//
// There is no cgo. Win32 and COM are called through x/sys/windows, and purego handles the few COM
// calls that pass floats in registers, because Go's own Windows syscalls never load the float
// registers on arm64.
//
// This file holds the parts that don't call Win32. It builds on every platform, so its tests can
// run on any machine.
package windows

import (
	"encoding/binary"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/rclone/rclone-ui/app/launcher/view"
)

func px(dip, scale float64) int32 { return int32(math.Round(dip * scale)) }

// drawDpi returns the DPI that the launcher draws at on a monitor with the given DPI and work
// area, in pixels. Windows' text size setting enlarges the whole launcher, as WebView2 enlarges
// the pages of the app's other windows. The enlargement is limited to what fits the work area.
func drawDpi(monitorDpi uint32, textScale float64, workW, workH int32) uint32 {
	base := float64(monitorDpi) / 96
	scale := base * textScale
	if workW > 0 && workH > 0 {
		scale = min(scale, float64(workW)/view.Width, float64(workH)/view.FullHeight())
	}
	return uint32(math.Round(max(scale, base) * 96))
}

const (
	vkTab    = 0x09
	vkReturn = 0x0D
	vkEscape = 0x1B
	vkUp     = 0x26
	vkDown   = 0x28
	vkPeriod = 0xBE // VK_OEM_PERIOD, the key that types "." on most layouts
)

// keyFor returns false to leave the key to the query box. Ctrl takes the place of ⌘, so Ctrl+.
// stops everything, as ⌘. does on macOS. Ctrl with Alt is AltGr on many layouts and types a
// character, so the launcher never takes it.
func keyFor(vk uint32, ctrl, shift, alt bool) (view.KeyEvent, bool) {
	switch {
	case vk == vkEscape:
		return view.KeyEvent{Key: view.KeyEsc}, true
	case vk == vkReturn:
		return view.KeyEvent{Key: view.KeyEnter}, true
	case vk == vkUp:
		return view.KeyEvent{Key: view.KeyUp}, true
	case vk == vkDown:
		return view.KeyEvent{Key: view.KeyDown}, true
	case vk == vkTab && !shift:
		return view.KeyEvent{Key: view.KeyTab}, true
	case !ctrl || alt:
		return view.KeyEvent{}, false
	case vk == 'K':
		return view.KeyEvent{Key: view.KeyActions}, true
	case vk >= '0' && vk <= '9':
		return view.KeyEvent{Key: view.KeyRow, Char: rune(vk)}, true
	case vk >= 'A' && vk <= 'Z':
		return view.KeyEvent{Key: view.KeyRow, Char: rune(vk-'A') + 'a'}, true
	case vk == vkPeriod:
		return view.KeyEvent{Key: view.KeyRow, Char: '.'}, true
	}
	return view.KeyEvent{}, false
}

// colorF is a D2D1_COLOR_F: red, green, blue and alpha from 0 to 1.
type colorF struct{ R, G, B, A float32 }

type palette struct {
	// surface is the colour of the band behind the query box, and of the whole window when there
	// is no acrylic.
	surface         colorF
	text, secondary colorF
	separator       colorF // the hairline under the query band
	icon            string // #rrggbb
	muted           string // #rrggbb, the secondary text colour over the surface, for a glyph
	// Windows 11's red and green for text and glyphs. critical is used for the icon of a danger
	// row, for the stop button while something is running, and for a failed status. success is
	// used for a status that succeeded.
	critical, success colorF
	danger            colorF // the highlight of a selected danger row, under the white onAccent text
}

// onAccent holds the text colours of the selected row on the accent colour. They are the same in
// both modes.
var onAccent = struct {
	text, secondary colorF
	icon            string
}{colorF{1, 1, 1, 1}, colorF{1, 1, 1, 0.8}, "#ffffff"}

// paletteFor takes its colours from Windows 11's own flyout surfaces.
func paletteFor(dark bool) palette {
	red := colorF{0.769, 0.169, 0.110, 1} // #c42b1c
	if dark {
		return palette{
			surface:   colorF{0.125, 0.125, 0.125, 1}, // #202020
			text:      colorF{1, 1, 1, 1},
			secondary: colorF{1, 1, 1, 0.6},
			separator: colorF{1, 1, 1, 0.08},
			icon:      "#e6e6e6",
			muted:     "#a6a6a6",
			critical:  colorF{1, 0.6, 0.643, 1},       // #ff99a4
			success:   colorF{0.424, 0.796, 0.373, 1}, // #6ccb5f
			danger:    red,
		}
	}
	return palette{
		surface:   colorF{0.976, 0.976, 0.976, 1}, // #f9f9f9
		text:      colorF{0.1, 0.1, 0.1, 1},
		secondary: colorF{0, 0, 0, 0.6},
		separator: colorF{0, 0, 0, 0.08},
		icon:      "#1f1f1f",
		muted:     "#646464",
		critical:  red,
		success:   colorF{0.059, 0.482, 0.059, 1}, // #0f7b0f
		danger:    red,
	}
}

// colorRef converts c to a GDI COLORREF (0x00bbggrr) for the query box. Alpha is dropped.
func colorRef(c colorF) uint32 {
	b := func(f float32) uint32 { return uint32(math.Round(float64(f) * 255)) }
	return b(c.R) | b(c.G)<<8 | b(c.B)<<16
}

// hex converts c to #rrggbb for a glyph. Alpha is dropped.
func hex(c colorF) string {
	r := colorRef(c)
	return fmt.Sprintf("#%02x%02x%02x", r&0xFF, r>>8&0xFF, r>>16&0xFF)
}

// announcement returns what a screen reader says for the selected row.
func announcement(s view.Snapshot) string {
	if s.Selected < 0 || s.Selected >= len(s.Rows) {
		return ""
	}
	r := s.Rows[s.Selected]
	parts := make([]string, 0, 4)
	for _, p := range []string{r.Group, r.Title, r.Subtitle, r.Tail} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, ", ")
}

// textRange is a run of text measured in UTF-16 code units, as DirectWrite counts them.
type textRange struct {
	start, length uint32
}

// packed returns the range as a DWRITE_TEXT_RANGE passed by value: two UINT32s in one register.
func (r textRange) packed() uint64 { return uint64(r.start) | uint64(r.length)<<32 }

// boldRanges converts the bold runes of s, given as rune indexes by the launcher, into UTF-16
// runs. A rune outside the BMP takes two units, and adjacent runes are merged into one run.
func boldRanges(s string, bold []int) []textRange {
	if len(bold) == 0 {
		return nil
	}
	runes := []rune(s)
	offsets := make([]uint32, len(runes)+1)
	for i, r := range runes {
		n := uint32(1)
		if utf16.RuneLen(r) == 2 {
			n = 2
		}
		offsets[i+1] = offsets[i] + n
	}
	idx := append([]int(nil), bold...)
	sort.Ints(idx)
	var out []textRange
	for _, i := range idx {
		if i < 0 || i >= len(runes) {
			continue
		}
		start, end := offsets[i], offsets[i+1]
		if last := len(out) - 1; last >= 0 && out[last].start+out[last].length >= start {
			if e := out[last].start + out[last].length; end > e {
				out[last].length += end - e
			}
			continue
		}
		out = append(out, textRange{start: start, length: end - start})
	}
	return out
}

// wordStart returns the position that Ctrl+Backspace deletes back to from caret, in UTF-16
// units. It skips the spaces before the caret, then the word before them.
func wordStart(text []uint16, caret int) int {
	if caret > len(text) {
		caret = len(text)
	}
	i := caret
	for i > 0 && isSpace(text[i-1]) {
		i--
	}
	for i > 0 && !isSpace(text[i-1]) {
		i--
	}
	return i
}

func isSpace(u uint16) bool { return u == ' ' || u == '\t' }

// dropGrace is how long a blur waits after the mouse button is released over the window (see
// blurDue).
const dropGrace = 250 * time.Millisecond

// blurDue reports whether a blur that is waiting on the mouse should go ahead. It waits while a
// button is down, because a drag holds the button down the whole time and may end over the
// window. It also waits for dropGrace after the button is released over the window, because a
// drag may have just ended there. The drop (WM_DROPFILES) arrives after the button release,
// because the app the drag came from posts it.
func blurDue(down, over bool, up time.Duration) bool {
	return !down && (!over || up >= dropGrace)
}

// textKey identifies a text layout by its text, format, box size and bold runs (packed).
type textKey struct {
	format uintptr
	text   string
	w, h   float32
	bold   string
}

func newTextKey(format uintptr, text string, w, h float32, bold []textRange) textKey {
	b := make([]byte, 0, 8*len(bold))
	for _, r := range bold {
		b = binary.LittleEndian.AppendUint32(b, r.start)
		b = binary.LittleEndian.AppendUint32(b, r.length)
	}
	return textKey{format: format, text: text, w: w, h: h, bold: string(b)}
}

// layoutCache keeps the text layouts that were drawn. A frame that only moves the spinner or the
// footer line doesn't recreate them, and neither does a new snapshot for its unchanged rows. Each
// full frame (see frame) starts a new generation. Layouts that the previous frame drew but this one
// doesn't are released.
type layoutCache struct {
	cur, last map[textKey]uintptr
	release   func(uintptr)
}

// get returns 0 when build fails.
func (c *layoutCache) get(k textKey, build func() uintptr) uintptr {
	if l, ok := c.cur[k]; ok {
		return l
	}
	l, ok := c.last[k]
	if ok {
		delete(c.last, k)
	} else if l = build(); l == 0 {
		return 0
	}
	if c.cur == nil {
		c.cur = map[textKey]uintptr{}
	}
	c.cur[k] = l
	return l
}

// frame starts a full frame and releases the layouts that the previous frame didn't draw.
func (c *layoutCache) frame() {
	for _, l := range c.last {
		c.release(l)
	}
	clear(c.last)
	c.cur, c.last = c.last, c.cur
}

// swapProgress is a cubic ease-out from 0 to 1 over view.SwapFor.
func swapProgress(elapsed time.Duration) float32 {
	t := min(max(float64(elapsed)/float64(view.SwapFor), 0), 1)
	return float32(1 - math.Pow(1-t, 3))
}

// spinnerDot returns the position of dot i relative to the spinner's centre, in DIPs. The first
// dot is at the top.
func spinnerDot(i int) (x, y float32) {
	a := float64(i)*2*math.Pi/8 - math.Pi/2
	return float32(6 * math.Cos(a)), float32(6 * math.Sin(a))
}

// variant is a VARIANT holding a VT_I4. It has the type, three reserved words, the value, and the
// rest of the union (24 bytes on 64-bit Windows).
type variant struct {
	VT  uint16
	_   [3]uint16
	Val int32
	_   int32
	_   uint64
}

// aligned16 copies v to memory aligned to 16 bytes. The x64 convention requires this for a struct
// that is passed by value as a pointer to a copy, and Go's allocator doesn't guarantee it for every
// size.
func aligned16[T any](v T) *T {
	buf := make([]byte, unsafe.Sizeof(v)+15)
	off := (16 - uintptr(unsafe.Pointer(&buf[0]))%16) % 16
	p := (*T)(unsafe.Pointer(&buf[off]))
	*p = v
	return p
}
