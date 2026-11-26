//go:build windows

package windows

import (
	"fmt"
	"syscall"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/windows"

	"github.com/rclone/rclone-ui/app/launcher/icons"
)

// COM methods are called through the object's vtable. The index is the method's position in its
// interface declaration, counting the methods of the interfaces it derives from, starting with the
// three from IUnknown. Calls whose arguments are all integers and pointers go through
// syscall.SyscallN, and every pointer is converted inside the call expression so that it stays
// alive and doesn't move. Calls that pass floats go through purego (see bound), which puts them in
// the float registers that arm64 expects. Their Go pointers are typed so that purego keeps them
// alive.

func method(obj uintptr, index int) uintptr {
	o := *(***[128]uintptr)(unsafe.Pointer(&obj))
	return (*o)[index]
}

func release(obj uintptr) {
	if obj != 0 {
		_, _, _ = syscall.SyscallN(method(obj, 2), obj)
	}
}

func failed(hr uintptr) bool { return int32(hr) < 0 }

const d2derrRecreateTarget = 0x8899000C

var (
	iidD2D1Factory        = windows.GUID{Data1: 0x06152247, Data2: 0x6f50, Data3: 0x465a, Data4: [8]byte{0x92, 0x45, 0x11, 0x8b, 0xfd, 0x3b, 0x60, 0x07}}
	iidDWriteFactory      = windows.GUID{Data1: 0xb859ee5a, Data2: 0xd838, Data3: 0x4b5b, Data4: [8]byte{0xa2, 0xe8, 0x1a, 0xdc, 0x7d, 0x93, 0xdb, 0x48}}
	iidD2D1DeviceContext5 = windows.GUID{Data1: 0x7836d248, Data2: 0x68cc, Data3: 0x4df6, Data4: [8]byte{0xb9, 0xe8, 0xde, 0x99, 0x1b, 0xf6, 0x2e, 0xb7}}
)

type (
	rectF       struct{ Left, Top, Right, Bottom float32 }
	roundedRect struct {
		Rect             rectF
		RadiusX, RadiusY float32
	}
	ellipse   struct{ X, Y, RadiusX, RadiusY float32 }
	matrix3x2 struct{ M11, M12, M21, M22, Dx, Dy float32 }
	sizeU     struct{ Width, Height uint32 }

	renderTargetProps struct {
		Type       uint32
		Format     uint32
		AlphaMode  uint32
		DpiX, DpiY float32
		Usage      uint32
		MinLevel   uint32
	}
	hwndRenderTargetProps struct {
		Hwnd           uintptr
		Width, Height  uint32
		PresentOptions uint32
	}
	trimming struct{ Granularity, Delimiter, DelimiterCount uint32 }
)

var identity = matrix3x2{M11: 1, M22: 1}

const (
	dxgiFormatB8G8R8A8   = 87
	alphaPremultiplied   = 1
	alphaIgnore          = 3
	antialiasGrayscale   = 2
	antialiasAliased     = 1
	fontWeightNormal     = 400
	fontWeightSemiBold   = 600
	fontWeightBold       = 700
	textAlignLeading     = 0
	textAlignTrailing    = 1
	paragraphCenter      = 2
	wordWrapNone         = 1
	trimmingCharacter    = 1
	svgViewport          = 24.0
	textFormatTitleSize  = 15
	textFormatSmallSize  = 12
	textFormatLabelSize  = 11
	textFormatFamilyName = "Segoe UI"
)

const (
	presentRetainContents = 1
	presentImmediately    = 2
)

type floatCalls struct {
	createTextFormat map[uintptr]func(this uintptr, family *uint16, collection uintptr, weight, style, stretch uint32, size float32, locale *uint16, out *uintptr) int32
	createTextLayout map[uintptr]func(this uintptr, text *uint16, length uint32, format uintptr, maxWidth, maxHeight float32, out *uintptr) int32
	byValue          byValueCalls
}

func bound[F any](cache map[uintptr]F, fn uintptr) F {
	if f, ok := cache[fn]; ok {
		return f
	}
	var f F
	purego.RegisterFunc(&f, fn)
	cache[fn] = f
	return f
}

type svgKey struct {
	icon   icons.Name
	colour string
}

type gfx struct {
	factory, dwrite           uintptr
	title, small, tail, label uintptr
	layouts                   layoutCache

	rt             uintptr
	dc5            uintptr
	brush          uintptr
	svgs           map[svgKey]uintptr
	whole, drawing bool

	calls floatCalls
}

func newGfx() (*gfx, error) {
	g := &gfx{svgs: map[svgKey]uintptr{}, layouts: layoutCache{release: release}, calls: floatCalls{
		createTextFormat: map[uintptr]func(uintptr, *uint16, uintptr, uint32, uint32, uint32, float32, *uint16, *uintptr) int32{},
		createTextLayout: map[uintptr]func(uintptr, *uint16, uint32, uintptr, float32, float32, *uintptr) int32{},
		byValue:          newByValueCalls(),
	}}
	if err := procD2D1CreateFactory.Find(); err != nil {
		return nil, fmt.Errorf("direct2d: %w", err)
	}
	hr, _, _ := procD2D1CreateFactory.Call(0, uintptr(unsafe.Pointer(&iidD2D1Factory)), 0, uintptr(unsafe.Pointer(&g.factory)))
	if failed(hr) {
		return nil, fmt.Errorf("direct2d factory: %#x", uint32(hr))
	}
	hr, _, _ = procDWriteCreateFactory.Call(0, uintptr(unsafe.Pointer(&iidDWriteFactory)), uintptr(unsafe.Pointer(&g.dwrite)))
	if failed(hr) {
		release(g.factory)
		return nil, fmt.Errorf("directwrite factory: %#x", uint32(hr))
	}
	var err error
	if g.title, err = g.textFormat(textFormatTitleSize, fontWeightNormal, textAlignLeading); err == nil {
		if g.small, err = g.textFormat(textFormatSmallSize, fontWeightNormal, textAlignLeading); err == nil {
			if g.tail, err = g.textFormat(textFormatSmallSize, fontWeightNormal, textAlignTrailing); err == nil {
				g.label, err = g.textFormat(textFormatLabelSize, fontWeightSemiBold, textAlignLeading)
			}
		}
	}
	if err != nil {
		for _, o := range []uintptr{g.title, g.small, g.tail, g.dwrite, g.factory} {
			release(o)
		}
		return nil, err
	}
	return g, nil
}

func (g *gfx) textFormat(size float32, weight, align uint32) (uintptr, error) {
	family, _ := windows.UTF16PtrFromString(textFormatFamilyName)
	locale, _ := windows.UTF16PtrFromString("en-us")
	var f uintptr
	call := bound(g.calls.createTextFormat, method(g.dwrite, 15))
	if hr := call(g.dwrite, family, 0, weight, 0, 5, size, locale, &f); hr < 0 || f == 0 {
		return 0, fmt.Errorf("text format: %#x", uint32(hr))
	}
	_, _, _ = syscall.SyscallN(method(f, 3), f, uintptr(align))
	_, _, _ = syscall.SyscallN(method(f, 4), f, paragraphCenter)
	_, _, _ = syscall.SyscallN(method(f, 5), f, wordWrapNone)
	var sign uintptr
	hr, _, _ := syscall.SyscallN(method(g.dwrite, 20), g.dwrite, f, uintptr(unsafe.Pointer(&sign)))
	if !failed(hr) && sign != 0 {
		t := trimming{Granularity: trimmingCharacter}
		_, _, _ = syscall.SyscallN(method(f, 9), f, uintptr(unsafe.Pointer(&t)), sign)
		release(sign)
	}
	return f, nil
}

func (g *gfx) target(hwnd uintptr, dpi uint32, glass bool) bool {
	if g.rt != 0 {
		return true
	}
	c := clientRect(hwnd)
	alpha := uint32(alphaIgnore)
	if glass {
		alpha = alphaPremultiplied
	}
	props := renderTargetProps{Format: dxgiFormatB8G8R8A8, AlphaMode: alpha, DpiX: float32(dpi), DpiY: float32(dpi)}
	hprops := hwndRenderTargetProps{Hwnd: hwnd, Width: uint32(max(c.width(), 1)), Height: uint32(max(c.height(), 1)),
		PresentOptions: presentRetainContents | presentImmediately}
	hr, _, _ := syscall.SyscallN(method(g.factory, 14), g.factory, uintptr(unsafe.Pointer(&props)),
		uintptr(unsafe.Pointer(&hprops)), uintptr(unsafe.Pointer(&g.rt)))
	if failed(hr) || g.rt == 0 {
		g.rt = 0
		return false
	}
	// ClearType needs an opaque background.
	if glass {
		_, _, _ = syscall.SyscallN(method(g.rt, 34), g.rt, antialiasGrayscale)
	}
	white := colorF{1, 1, 1, 1}
	hr, _, _ = syscall.SyscallN(method(g.rt, 8), g.rt, uintptr(unsafe.Pointer(&white)), 0, uintptr(unsafe.Pointer(&g.brush)))
	if failed(hr) {
		g.discard()
		return false
	}
	hr, _, _ = syscall.SyscallN(method(g.rt, 0), g.rt, uintptr(unsafe.Pointer(&iidD2D1DeviceContext5)), uintptr(unsafe.Pointer(&g.dc5)))
	if failed(hr) {
		g.dc5 = 0
	}
	g.whole = true
	return true
}

func (g *gfx) discard() {
	for k, d := range g.svgs {
		release(d)
		delete(g.svgs, k)
	}
	release(g.brush)
	release(g.dc5)
	release(g.rt)
	g.brush, g.dc5, g.rt = 0, 0, 0
}

func (g *gfx) resize(w, h int32) {
	if g.rt == 0 {
		return
	}
	s := sizeU{uint32(max(w, 1)), uint32(max(h, 1))}
	_, _, _ = syscall.SyscallN(method(g.rt, 58), g.rt, uintptr(unsafe.Pointer(&s)))
	g.whole = true
}

func (g *gfx) frame() {
	g.whole = false
	g.layouts.frame()
}

func (g *gfx) begin(dirty rectF, c colorF) {
	_, _, _ = syscall.SyscallN(method(g.rt, 48), g.rt)
	g.drawing = true
	_, _, _ = syscall.SyscallN(method(g.rt, 30), g.rt, uintptr(unsafe.Pointer(&identity)))
	g.clip(dirty)
	_, _, _ = syscall.SyscallN(method(g.rt, 47), g.rt, uintptr(unsafe.Pointer(&c)))
}

func (g *gfx) end() bool {
	g.unclip()
	hr, _, _ := syscall.SyscallN(method(g.rt, 49), g.rt, 0, 0)
	g.drawing = false
	return uint32(hr) != d2derrRecreateTarget
}

func (g *gfx) colour(c colorF) {
	_, _, _ = syscall.SyscallN(method(g.brush, 8), g.brush, uintptr(unsafe.Pointer(&c)))
}

func (g *gfx) fillRounded(r rectF, radius float32, c colorF) {
	g.colour(c)
	rr := roundedRect{Rect: r, RadiusX: radius, RadiusY: radius}
	_, _, _ = syscall.SyscallN(method(g.rt, 19), g.rt, uintptr(unsafe.Pointer(&rr)), g.brush)
}

func (g *gfx) fillEllipse(e ellipse, c colorF) {
	g.colour(c)
	_, _, _ = syscall.SyscallN(method(g.rt, 21), g.rt, uintptr(unsafe.Pointer(&e)), g.brush)
}

// clip limits drawing to r until unclip. Each clip must be paired with an unclip before end, or
// EndDraw fails. Direct2D applies the transform that is set when the clip is pushed. Between draws
// that is the identity, so the transform that icon sets later doesn't move the clip.
func (g *gfx) clip(r rectF) {
	_, _, _ = syscall.SyscallN(method(g.rt, 45), g.rt, uintptr(unsafe.Pointer(&r)), antialiasAliased)
}

func (g *gfx) unclip() {
	_, _, _ = syscall.SyscallN(method(g.rt, 46), g.rt)
}

func (g *gfx) text(format uintptr, s string, r rectF, c colorF, bold []textRange) {
	if s == "" {
		return
	}
	w, h := r.Right-r.Left, r.Bottom-r.Top
	layout := g.layouts.get(newTextKey(format, s, w, h, bold), func() uintptr { return g.textLayout(format, s, w, h, bold) })
	if layout == 0 {
		return
	}
	g.colour(c)
	g.drawTextLayout(r.Left, r.Top, layout)
}

func (g *gfx) textLayout(format uintptr, s string, w, h float32, bold []textRange) uintptr {
	u, err := windows.UTF16FromString(s)
	if err != nil || len(u) < 2 {
		return 0
	}
	n := uint32(len(u) - 1)
	var layout uintptr
	call := bound(g.calls.createTextLayout, method(g.dwrite, 18))
	if hr := call(g.dwrite, &u[0], n, format, w, h, &layout); hr < 0 || layout == 0 {
		return 0
	}
	for _, b := range bold {
		// IDWriteTextLayout::SetFontWeight, vtable 32. DWRITE_TEXT_RANGE passed by value fits in
		// one register.
		_, _, _ = syscall.SyscallN(method(layout, 32), layout, fontWeightBold, uintptr(b.packed()))
	}
	return layout
}

func (g *gfx) icon(n icons.Name, colour string, x, y, size float32) {
	if g.dc5 == 0 || n == "" {
		return
	}
	k := svgKey{n, colour}
	doc, ok := g.svgs[k]
	if !ok {
		doc = g.svgDocument(icons.Tinted(n, colour))
		g.svgs[k] = doc
	}
	if doc == 0 {
		return
	}
	s := size / svgViewport
	m := matrix3x2{M11: s, M22: s, Dx: x, Dy: y}
	_, _, _ = syscall.SyscallN(method(g.rt, 30), g.rt, uintptr(unsafe.Pointer(&m)))
	_, _, _ = syscall.SyscallN(method(g.dc5, 116), g.dc5, doc)
	_, _, _ = syscall.SyscallN(method(g.rt, 30), g.rt, uintptr(unsafe.Pointer(&identity)))
}

func (g *gfx) svgDocument(svg string) uintptr {
	if svg == "" {
		return 0
	}
	stream := memStream([]byte(svg))
	if stream == 0 {
		return 0
	}
	defer release(stream)
	return g.createSvgDocument(stream, svgViewport, svgViewport)
}
