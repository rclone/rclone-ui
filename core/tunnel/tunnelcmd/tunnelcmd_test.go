package tunnelcmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs"
	"rsc.io/qr"
)

func TestServedURL(t *testing.T) {
	line := `{"time":"2026-09-30T12:00:00Z","level":"notice","msg":"The tunnel is on at https://abc-def.trycloudflare.com","source":"tunnelcmd/tunnelcmd.go:120"}`
	if got := ServedURL(line); got != "https://abc-def.trycloudflare.com" {
		t.Fatalf("%q", got)
	}
	// cloudflared's own line with the address is logged before the tunnel is connected.
	if got := ServedURL(`{"level":"info","message":"|  https://abc-def.trycloudflare.com  |"}`); got != "" {
		t.Fatalf("%q", got)
	}
}

func TestCloudflaredLevel(t *testing.T) {
	for l, want := range map[fs.LogLevel]string{
		fs.LogLevelDebug:  "info", // cloudflared's debug lines include the rc's credentials
		fs.LogLevelInfo:   "info",
		fs.LogLevelNotice: "warn",
		fs.LogLevelError:  "error",
	} {
		if got := cloudflaredLevel(l); got != want {
			t.Errorf("%v: %q, want %q", l, got, want)
		}
	}
}

// TestPairing checks that the QR code holds the same data as the one in the Mobile & Remote
// Control window, and draws as a square with its margin, with two rows of modules per line.
func TestPairing(t *testing.T) {
	b, _ := json.Marshal(Pairing{URL: "https://abc.trycloudflare.com", User: "u", Pass: "p"})
	if string(b) != `{"url":"https://abc.trycloudflare.com","user":"u","pass":"p"}` {
		t.Fatalf("%s", b)
	}
	code, err := qr.Encode(string(b), qr.M)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(qrBlocks(code.Size, code.Black), "\n"), "\n")
	n := code.Size + 2*quiet
	if len(lines) != (n+1)/2 {
		t.Fatalf("%d lines for %d rows", len(lines), n)
	}
	// Every module read back from the blocks matches the code.
	for row, l := range lines {
		cells := []rune(strings.TrimSuffix(strings.TrimPrefix(l, "\x1b[30m\x1b[107m"), "\x1b[0m"))
		if len(cells) != n {
			t.Fatalf("a line of %d columns, want %d", len(cells), n)
		}
		for x, c := range cells {
			top := c == '█' || c == '▀'
			bottom := c == '█' || c == '▄'
			y := 2 * row
			if top != code.Black(x-quiet, y-quiet) || bottom != code.Black(x-quiet, y+1-quiet) {
				t.Fatalf("module (%d, %d) drawn as %q", x-quiet, y-quiet, c)
			}
		}
	}
	// The margin is light, and the corner of the finder pattern is dark.
	if code.Black(-1, 0) || !code.Black(0, 0) {
		t.Fatal("the code's corner")
	}
}
