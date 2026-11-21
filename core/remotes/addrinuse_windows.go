package remotes

import "golang.org/x/sys/windows"

// errAddrInUse is the error a listener gets when another program holds its port. It uses
// Winsock's own number, because syscall.EADDRINUSE on Windows is a value that Go invented and
// no socket call returns.
var errAddrInUse error = windows.WSAEADDRINUSE
