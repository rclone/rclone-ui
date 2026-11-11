//go:build !windows

package remotes

import "syscall"

// errAddrInUse is the error a listener gets when another program holds its port.
var errAddrInUse error = syscall.EADDRINUSE
