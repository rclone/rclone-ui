package update

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestUninstallKeyIsTheInstallers(t *testing.T) {
	b, err := os.ReadFile("../../build/windows/nsis/project.nsi")
	if err != nil {
		t.Fatal(err)
	}
	defines := map[string]string{}
	for _, m := range regexp.MustCompile(`(?m)^!define (\w+) "([^"]*)"`).FindAllStringSubmatch(string(b), -1) {
		defines[m[1]] = m[2]
	}
	key := defines["UNINSTKEY"]
	for name, value := range defines {
		key = strings.ReplaceAll(key, "${"+name+"}", value)
	}
	if key != uninstallKey {
		t.Fatalf("the installer writes %q, the app reads %q", key, uninstallKey)
	}
}

// A portable copy doesn't update itself, and says how to update it by hand in plain words. It
// has no artifact of its own, so a check reads the platform's installer, as for a copied binary.
func TestPortableDoesNotUpdateItself(t *testing.T) {
	e := New(Options{Installed: TypePortable})
	if it := e.InstallType(); it != TypePortable {
		t.Fatalf("Options.Installed gave %q", it)
	}
	ok, why := e.CanSelfUpdate()
	if ok || why != PortableNote {
		t.Errorf("CanSelfUpdate = %v, %q", ok, why)
	}
	for _, want := range []string{"portable copy", "portable zip", "rcui.exe, winfsp.msi and the bin folder", "data folder and rclone.conf"} {
		if !strings.Contains(why, want) {
			t.Errorf("the explanation lacks %q: %q", want, why)
		}
	}
	if k := TypePortable.kind(); k != "" {
		t.Errorf("a portable copy updates from %q", k)
	}
	if _, err := e.Install(context.Background(), &Artifact{Path: "/nonexistent", Kind: KindNSIS}); !errors.Is(err, ErrCantSelfUpdate) {
		t.Errorf("Install = %v, want ErrCantSelfUpdate", err)
	}
	if got, want := ReleasePage("v4.0.2"), "https://github.com/rclone/rclone-ui/releases/tag/v4.0.2"; got != want {
		t.Errorf("ReleasePage = %q, want %q", got, want)
	}
}
