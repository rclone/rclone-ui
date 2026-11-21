//go:build windows && arm64

package windows

// On arm64, a struct of two floats passed by value is a homogeneous floating-point aggregate. It
// is passed in two float registers, just like two float arguments. Go's syscalls never load float
// registers, so these calls go through purego.

type byValueCalls struct {
	drawTextLayout map[uintptr]func(this uintptr, x, y float32, layout, brush uintptr, options uint32)
	createSvg      map[uintptr]func(this, stream uintptr, w, h float32, out *uintptr) int32
}

func newByValueCalls() byValueCalls {
	return byValueCalls{
		drawTextLayout: map[uintptr]func(uintptr, float32, float32, uintptr, uintptr, uint32){},
		createSvg:      map[uintptr]func(uintptr, uintptr, float32, float32, *uintptr) int32{},
	}
}

func (g *gfx) drawTextLayout(x, y float32, layout uintptr) {
	// ID2D1RenderTarget::DrawTextLayout, vtable 28: (origin, layout, brush, D2D1_DRAW_TEXT_OPTIONS_NONE)
	bound(g.calls.byValue.drawTextLayout, method(g.rt, 28))(g.rt, x, y, layout, g.brush, 0)
}

func (g *gfx) createSvgDocument(stream uintptr, w, h float32) uintptr {
	var doc uintptr
	// ID2D1DeviceContext5::CreateSvgDocument, vtable 115: (stream, viewportSize, out)
	if hr := bound(g.calls.byValue.createSvg, method(g.dc5, 115))(g.dc5, stream, w, h, &doc); hr < 0 {
		return 0
	}
	return doc
}
