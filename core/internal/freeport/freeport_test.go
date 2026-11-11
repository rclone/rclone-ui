package freeport

import (
	"net"
	"testing"
)

func TestLoopback(t *testing.T) {
	addr, err := Loopback()
	if err != nil {
		t.Fatal(err)
	}
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) || addr.Port == 0 {
		t.Fatalf("got %v", addr)
	}
	ln, err := net.Listen("tcp", addr.String())
	if err != nil {
		t.Fatalf("the port isn't free: %v", err)
	}
	_ = ln.Close()
}
