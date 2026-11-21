package rclone

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"slices"
	"testing"

	"github.com/rclone/rclone-ui/core/errs"
)

func TestCheckRemoteName(t *testing.T) {
	const charset = "A name may contain letters, digits, spaces and _ - . + @, and cannot start with - or a space, or end with one."
	const short = "A name can't be a single letter: on Windows that is a drive."
	for name, want := range map[string]string{
		"":              "Give the remote a name.",
		"x":             short,
		"C":             short,
		"my drive":      "",
		"a.b+c@d_e-f":   "",
		"_x":            "",
		"-x":            charset,
		" x":            charset,
		"x ":            charset,
		"x:y":           charset,
		"x/y":           charset,
		"ünïcode":       "",
		"云盘":            "",
		"Données perso": "",
		"é":             "",
		"1":             "",
		"_":             "",
		"z":             short,
		"xy":            "",
		"work2":         "",
		"@home":         "",
		"with\ttab":     charset,
		"trailing-dot.": "",
		"ends-":         charset,
	} {
		if got := problem(CheckRemoteName("name", name)); got != want {
			t.Errorf("CheckRemoteName(%q) = %q, want %q", name, got, want)
		}
	}
	if got := problem(CheckNewRemoteName("name", "work", []string{"home", "work"})); got != "A remote called work already exists." {
		t.Errorf("clash: %q", got)
	}
	if got := problem(CheckNewRemoteName("name", "new", []string{"home"})); got != "" {
		t.Errorf("new name: %q", got)
	}
	if got := problem(CheckNewRemoteName("name", "-x", []string{"-x"})); got != charset {
		t.Errorf("the grammar is checked first: %q", got)
	}
	if err := CheckNewRemoteName("newName", "x", nil); errs.FieldOf(err) != "newName" {
		t.Errorf("the refusal is on %q, want newName", errs.FieldOf(err))
	}
}

// problem returns a refusal's message, or "" for none.
func problem(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestReconnectAdvice(t *testing.T) {
	for text, want := range map[string]string{
		`token expired and there's no refresh token - manually refresh with "rclone config reconnect work:"`:   "work",
		`couldn't fetch token: maybe token expired? - try refreshing with "rclone config reconnect my drive:"`: "my drive",
		`crypt: failed: empty token found - please run "rclone config reconnect gdrive:"`:                      "gdrive",
		`failed to get token - please run: rclone config reconnect box1: - 401`:                                "box1",
		`mnemonic is required - please run: rclone config reconnect ix:`:                                       "ix",
		`failed to get token - please run: rclone config reconnect 云盘: - 401`:                                  "云盘",
		`use the command: rclone config reconnect <remote name>: `:                                             "",
		`zoho: Run rclone config reconnect to fix this issue.: context canceled`:                               "",
		"no refresh token found - run `rclone config reconnect`":                                               "",
		`something else entirely`: "",
	} {
		got, ok := ReconnectAdvice(errors.New(text))
		if got != want || ok != (want != "") {
			t.Errorf("ReconnectAdvice(%q) = %q, %v; want %q", text, got, ok, want)
		}
	}
	if _, ok := ReconnectAdvice(nil); ok {
		t.Error("nil error has advice")
	}
	wrapped := fmt.Errorf("listing: %w", errors.New(`manually refresh with "rclone config reconnect work:"`))
	if !HasReconnectAdvice(wrapped, "work") || HasReconnectAdvice(wrapped, "wor") || HasReconnectAdvice(nil, "work") {
		t.Error("HasReconnectAdvice is not exact")
	}
}

func TestDisks(t *testing.T) {
	disks, err := Disks(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()
	if home != "" && !slices.Contains(disks, home) {
		t.Errorf("no home folder in %v", disks)
	}
	if runtime.GOOS != "windows" && !slices.Contains(disks, "/") {
		t.Errorf("no root in %v", disks)
	}
}
