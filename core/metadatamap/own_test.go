package metadatamap

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// Own recognizes the app's own mapper with or without the executable in front, and returns it
// without the path. Another program, another subcommand, and rules that don't parse are not the
// app's own.
func TestOwn(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "rcui")
	if err := os.WriteFile(exe, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	// Windows may not allow a link, and then the link is the executable itself.
	link := filepath.Join(t.TempDir(), "rcui-link")
	if os.Symlink(exe, link) != nil {
		link = exe
	}
	for _, tc := range []struct {
		name string
		argv []string
		want []string
	}{
		{"the subcommand", []string{"metadata-map", "--map", "a=b"}, []string{"metadata-map", "--map", "a=b"}},
		{"the executable in front", []string{exe, "metadata-map", "--drop", "x"}, []string{"metadata-map", "--drop", "x"}},
		{"a link to the executable", []string{link, "metadata-map"}, []string{"metadata-map"}},
		{"another program", []string{"/opt/bin/mapper", "metadata-map"}, nil},
		{"another subcommand", []string{exe, "serve"}, nil},
		{"rules that don't parse", []string{"metadata-map", "--nope"}, nil},
		{"nothing", nil, nil},
	} {
		got, ok := Own(tc.argv, exe)
		if ok != (tc.want != nil) || !slices.Equal(got, tc.want) {
			t.Errorf("%s: %q %v, want %q", tc.name, got, ok, tc.want)
		}
	}
	// Without an executable, only the subcommand form is the app's own.
	if _, ok := Own([]string{exe, "metadata-map"}, ""); ok {
		t.Error("the executable counted without one to compare with")
	}
}

func TestRunnable(t *testing.T) {
	if got := Runnable([]string{"metadata-map", "--drop", "x"}, "/opt/rcui"); !slices.Equal(got, []string{"/opt/rcui", "metadata-map", "--drop", "x"}) {
		t.Errorf("own mapper %q", got)
	}
	if got := Runnable([]string{"python3", "map.py"}, "/opt/rcui"); !slices.Equal(got, []string{"python3", "map.py"}) {
		t.Errorf("another program %q", got)
	}
}
