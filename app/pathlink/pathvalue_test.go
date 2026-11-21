package pathlink

import "testing"

func TestPathValue(t *testing.T) {
	const bin = `C:\Users\me\AppData\Local\Rclone UI\bin`
	value := `%USERPROFILE%\bin;C:\Tools\;`
	if pathHas(value, bin) {
		t.Fatal("listed before it was added")
	}
	with := pathWith(value, bin)
	if with != `%USERPROFILE%\bin;C:\Tools\;`+bin || !pathHas(with, `c:\users\me\appdata\local\rclone ui\bin\`) {
		t.Fatalf("with: %q", with)
	}
	if pathWith(with, bin) != with {
		t.Fatal("added twice")
	}
	if got := pathWithout(with+";"+bin, bin); got != `%USERPROFILE%\bin;C:\Tools\` {
		t.Fatalf("without: %q", got)
	}
	if got := pathWith("", bin); got != bin {
		t.Fatalf("to an empty PATH: %q", got)
	}
}
