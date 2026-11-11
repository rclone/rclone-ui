package children

import "testing"

func TestMountedReadsMountinfo(t *testing.T) {
	if ok, err := Mounted("/"); err != nil || !ok {
		t.Fatalf("Mounted(/) = %v, %v", ok, err)
	}
	if ok, err := Mounted(t.TempDir()); err != nil || ok {
		t.Fatalf("Mounted(a plain folder) = %v, %v", ok, err)
	}
}
