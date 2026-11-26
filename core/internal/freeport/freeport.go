package freeport

import "net"

// Loopback returns a 127.0.0.1 address whose port is free right now. Another process may take the
// port before the caller listens on it.
func Loopback() (*net.TCPAddr, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().(*net.TCPAddr), nil
}
