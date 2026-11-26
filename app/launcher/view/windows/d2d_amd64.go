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

func pack2(a, b float32) uintptr {
	return uintptr(math.Float32bits(a)) | uintptr(math.Float32bits(b))<<32
}

func (g *gfx) drawTextLayout(x, y float32, layout uintptr) {
	_, _, _ = syscall.SyscallN(method(g.rt, 28), g.rt, pack2(x, y), layout, g.brush, 0)
}

func (g *gfx) createSvgDocument(stream uintptr, w, h float32) uintptr {
	var doc uintptr
	hr, _, _ := syscall.SyscallN(method(g.dc5, 115), g.dc5, stream, pack2(w, h), uintptr(unsafe.Pointer(&doc)))
	if failed(hr) {
		return 0
	}
	return doc
}
