//go:build windows && amd64

package windows

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// setHwndProp calls IAccPropServices::SetHwndProp (vtable slot 6) with (hwnd, idObject, idChild,
// MSAAPROPID, VARIANT), where the last two are passed by value. On x64, a struct larger than eight
// bytes that is passed by value is sent as a pointer to a 16-byte-aligned copy.
func setHwndProp(svc, hwnd, idObject, idChild uintptr, prop *windows.GUID, v *variant) uintptr {
	p, val := aligned16(*prop), aligned16(*v)
	r, _, _ := syscall.SyscallN(method(svc, 6), svc, hwnd, idObject, idChild,
		uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(val)))
	return r
}
