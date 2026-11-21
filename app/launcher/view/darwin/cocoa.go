//go:build darwin

package darwin

// This package calls Cocoa from Go through purego's objc runtime, without any Objective-C
// sources. It follows three rules:
//   - Methods implemented in Go take only simple arguments. Struct parameters aren't supported,
//     so the package can't implement drawRect:.
//   - Calls never pass more than eight arguments. Apple's arm64 ABI packs small arguments on the
//     stack, and purego doesn't.
//   - Every call runs on the main thread.

import (
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego/objc"
)

type nsPoint struct{ X, Y float64 }
type nsSize struct{ W, H float64 }
type nsRect struct {
	Origin nsPoint
	Size   nsSize
}
type nsRange struct{ Loc, Len uint }

func rect(x, y, w, h float64) nsRect { return nsRect{nsPoint{x, y}, nsSize{w, h}} }

var sels sync.Map

// sel caches selectors, because registering one takes the runtime's lock.
func sel(name string) objc.SEL {
	if s, ok := sels.Load(name); ok {
		return s.(objc.SEL)
	}
	s := objc.RegisterName(name)
	sels.Store(name, s)
	return s
}

func class(name string) objc.ID { return objc.ID(objc.GetClass(name)) }

func msg(id objc.ID, name string, args ...any) objc.ID { return id.Send(sel(name), args...) }

func msgBool(id objc.ID, name string, args ...any) bool {
	return objc.Send[bool](id, sel(name), args...)
}

func msgRect(id objc.ID, name string, args ...any) nsRect {
	return objc.Send[nsRect](id, sel(name), args...)
}

func msgPoint(id objc.ID, name string, args ...any) nsPoint {
	return objc.Send[nsPoint](id, sel(name), args...)
}

func alloc(cls string) objc.ID { return msg(class(cls), "alloc") }

func nsString(s string) objc.ID {
	b := append([]byte(s), 0)
	id := msg(class("NSString"), "stringWithUTF8String:", unsafe.Pointer(&b[0]))
	runtime.KeepAlive(b)
	return id
}

func goString(id objc.ID) string {
	if id == 0 {
		return ""
	}
	n := objc.Send[uint](id, sel("lengthOfBytesUsingEncoding:"), uint(4)) // UTF-8
	if n == 0 {
		return ""
	}
	p := objc.Send[*byte](id, sel("UTF8String"))
	if p == nil {
		return ""
	}
	return string(unsafe.Slice(p, n))
}

func nsData(b []byte) objc.ID {
	id := msg(class("NSData"), "dataWithBytes:length:", unsafe.Pointer(&b[0]), uint(len(b)))
	runtime.KeepAlive(b)
	return id
}

func color(name string) objc.ID { return msg(class("NSColor"), name) }

func font(size float64, bold bool) objc.ID {
	if bold {
		return msg(class("NSFont"), "boldSystemFontOfSize:", size)
	}
	return msg(class("NSFont"), "systemFontOfSize:", size)
}

func label(size float64) objc.ID {
	l := msg(class("NSTextField"), "labelWithString:", nsString(""))
	msg(l, "setFont:", font(size, false))
	msg(l, "setLineBreakMode:", uint(4)) // truncate the tail
	return l
}

// attributed returns s with the runes at the indexes in bold drawn in bold. The caller releases it.
func attributed(s string, size float64, col objc.ID, bold []int) objc.ID {
	attrs := msg(class("NSMutableDictionary"), "dictionary")
	msg(attrs, "setObject:forKey:", font(size, false), nsString("NSFont"))
	msg(attrs, "setObject:forKey:", col, nsString("NSColor"))
	as := msg(alloc("NSMutableAttributedString"), "initWithString:attributes:", nsString(s), attrs)
	if len(bold) == 0 {
		return as
	}
	// NSString ranges count UTF-16 code units.
	u16 := make([]uint, 0, len(s)+1)
	n := uint(0)
	for _, r := range s {
		u16 = append(u16, n)
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	u16 = append(u16, n)
	isBold := make(map[int]bool, len(bold))
	for _, i := range bold {
		isBold[i] = true
	}
	bf := font(size, true)
	for i := 0; i < len(u16)-1; {
		if !isBold[i] {
			i++
			continue
		}
		j := i
		for j < len(u16)-1 && isBold[j] {
			j++
		}
		msg(as, "addAttribute:value:range:", nsString("NSFont"), bf, nsRange{u16[i], u16[j] - u16[i]})
		i = j
	}
	return as
}
