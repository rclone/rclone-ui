//go:build windows && amd64

package windows

import (
	"math"
	"syscall"
	"unsafe"
)

// On amd64, a struct of two floats passed by value is eight bytes in one integer register (the
// Windows x64 convention), so these calls only need syscall.SyscallN.

type byValueCalls struct{}

func newByValueCalls() byValueCalls { return byValueCalls{} }

// pack2 packs a D2D1_POINT_2F or D2D1_SIZE_F into the register value that holds it.
func pack2(a, b float32) uintptr {
	return uintptr(math.Float32bits(a)) | uintptr(math.Float32bits(b))<<32
}

func (g *gfx) drawTextLayout(x, y float32, layout uintptr) {
	// ID2D1RenderTarget::DrawTextLayout, vtable 28: (origin, layout, brush, D2D1_DRAW_TEXT_OPTIONS_NONE)
	_, _, _ = syscall.SyscallN(method(g.rt, 28), g.rt, pack2(x, y), layout, g.brush, 0)
}

func (g *gfx) createSvgDocument(stream uintptr, w, h float32) uintptr {
	var doc uintptr
	// ID2D1DeviceContext5::CreateSvgDocument, vtable 115: (stream, viewportSize, out)
	hr, _, _ := syscall.SyscallN(method(g.dc5, 115), g.dc5, stream, pack2(w, h), uintptr(unsafe.Pointer(&doc)))
	if failed(hr) {
		return 0
	}
	return doc
}
