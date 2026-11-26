//go:build !windows

package remotes

import "syscall"

var errAddrInUse error = syscall.EADDRINUSE
