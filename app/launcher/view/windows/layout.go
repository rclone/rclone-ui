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

const userDefaultScreenDpi = 96

func drawDpi(monitorDpi uint32, textScale float64, workW, workH int32) uint32 {
	base := float64(monitorDpi) / userDefaultScreenDpi
	scale := base * textScale
	if workW > 0 && workH > 0 {
		scale = min(scale, float64(workW)/view.Width, float64(workH)/view.FullHeight())
	}
	return uint32(math.Round(max(scale, base) * userDefaultScreenDpi))
}

const (
	vkTab       = 0x09
	vkReturn    = 0x0D
	vkEscape    = 0x1B
	vkUp        = 0x26
	vkDown      = 0x28
	vkOemPeriod = 0xBE
)

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
	case vk == vkOemPeriod:
		return view.KeyEvent{Key: view.KeyRow, Char: view.StopAllChar}, true
	}
	return view.KeyEvent{}, false
}

type colorF struct{ R, G, B, A float32 }

type palette struct {
	surface           colorF
	text, secondary   colorF
	separator         colorF
	icon              string
	muted             string
	critical, success colorF
	danger            colorF
}

var onAccent = struct {
	text, secondary colorF
	icon            string
}{colorF{1, 1, 1, 1}, colorF{1, 1, 1, 0.8}, "#ffffff"}

func rgb(rrggbb uint32) colorF {
	c := func(shift uint) float32 { return float32(rrggbb>>shift&0xFF) / 255 }
	return colorF{c(16), c(8), c(0), 1}
}

func paletteFor(dark bool) palette {
	red := rgb(0xc42b1c)
	if dark {
		return palette{
			surface:   rgb(0x202020),
			text:      colorF{1, 1, 1, 1},
			secondary: colorF{1, 1, 1, 0.6},
			separator: colorF{1, 1, 1, 0.08},
			icon:      "#e6e6e6",
			muted:     "#a6a6a6",
			critical:  rgb(0xff99a4),
			success:   rgb(0x6ccb5f),
			danger:    red,
		}
	}
	return palette{
		surface:   rgb(0xf9f9f9),
		text:      colorF{0.1, 0.1, 0.1, 1},
		secondary: colorF{0, 0, 0, 0.6},
		separator: colorF{0, 0, 0, 0.08},
		icon:      "#1f1f1f",
		muted:     "#646464",
		critical:  red,
		success:   rgb(0x0f7b0f),
		danger:    red,
	}
}

func colorRef(c colorF) uint32 {
	b := func(f float32) uint32 { return uint32(math.Round(float64(f) * 255)) }
	return b(c.R) | b(c.G)<<8 | b(c.B)<<16
}

func hex(c colorF) string {
	r := colorRef(c)
	return fmt.Sprintf("#%02x%02x%02x", r&0xFF, r>>8&0xFF, r>>16&0xFF)
}

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

type utf16Range struct {
	start, length uint32
}

// packed returns the range as a DWRITE_TEXT_RANGE passed by value: two UINT32s in one register.
func (r utf16Range) packed() uint64 { return uint64(r.start) | uint64(r.length)<<32 }

func boldRanges(s string, bold []int) []utf16Range {
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
	var out []utf16Range
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
		out = append(out, utf16Range{start: start, length: end - start})
	}
	return out
}

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

const dropGrace = 250 * time.Millisecond

// blurDue reports whether a blur that is waiting on the mouse should go ahead. It waits while a
// button is down, because a drag holds the button down the whole time and may end over the
// window. It also waits for dropGrace after the button is released over the window, because a
// drag may have just ended there. The drop (WM_DROPFILES) arrives after the button release,
// because the app the drag came from posts it.
func blurDue(down, over bool, up time.Duration) bool {
	return !down && (!over || up >= dropGrace)
}

type textKey struct {
	format uintptr
	text   string
	w, h   float32
	bold   string
}

func newTextKey(format uintptr, text string, w, h float32, bold []utf16Range) textKey {
	b := make([]byte, 0, 8*len(bold))
	for _, r := range bold {
		b = binary.LittleEndian.AppendUint32(b, r.start)
		b = binary.LittleEndian.AppendUint32(b, r.length)
	}
	return textKey{format: format, text: text, w: w, h: h, bold: string(b)}
}

type layoutCache struct {
	cur, last map[textKey]uintptr
	release   func(uintptr)
}

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

func (c *layoutCache) frame() {
	for _, l := range c.last {
		c.release(l)
	}
	clear(c.last)
	c.cur, c.last = c.last, c.cur
}

func swapProgress(elapsed time.Duration) float32 {
	t := min(max(float64(elapsed)/float64(view.SwapFor), 0), 1)
	return float32(1 - math.Pow(1-t, 3))
}

const (
	spinDots   = 8
	spinRadius = 6.0
)

func spinnerDot(i int) (x, y float32) {
	a := float64(i)*2*math.Pi/spinDots - math.Pi/2
	return float32(spinRadius * math.Cos(a)), float32(spinRadius * math.Sin(a))
}

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
