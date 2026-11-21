// Package freeport finds a TCP port that nothing listens on, for a server the app starts.
package freeport

import "net"

// Loopback returns a 127.0.0.1 address whose port is free right now. Another process may take the
// port before the caller listens on it. The callers pass it to a child or a server, which then
// fails with a clear error.
func Loopback() (*net.TCPAddr, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().(*net.TCPAddr), nil
}
