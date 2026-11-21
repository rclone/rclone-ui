//go:build windows && arm64

package windows

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// setHwndProp calls IAccPropServices::SetHwndProp (vtable slot 6) with (hwnd, idObject, idChild,
// MSAAPROPID, VARIANT), where the last two are passed by value. On arm64, a struct of 16 bytes or
// less, such as the GUID, is passed in two general registers. A larger struct, such as the
// VARIANT, is passed as a pointer to a copy.
func setHwndProp(svc, hwnd, idObject, idChild uintptr, prop *windows.GUID, v *variant) uintptr {
	words := (*[2]uint64)(unsafe.Pointer(prop))
	val := aligned16(*v)
	r, _, _ := syscall.SyscallN(method(svc, 6), svc, hwnd, idObject, idChild,
		uintptr(words[0]), uintptr(words[1]), uintptr(unsafe.Pointer(val)))
	return r
}
