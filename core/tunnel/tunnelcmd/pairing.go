package tunnelcmd

import (
	"encoding/json"
	"strings"

	"github.com/rclone/rclone/lib/terminal"
	"rsc.io/qr"
)

// Pairing is what the QR code holds, the same as the QR code in the Mobile & Remote Control window.
type Pairing struct {
	URL  string `json:"url"`
	User string `json:"user"`
	Pass string `json:"pass"`
}

func printPairing(url, user, pass string) {
	b, _ := json.Marshal(Pairing{URL: url, User: user, Pass: pass})
	terminal.Start()
	var out strings.Builder
	out.WriteString("\nRclone UI remote tunnel\n\n")
	out.WriteString("  URL   " + url + "\n")
	out.WriteString("  User  " + user + "\n")
	out.WriteString("  Pass  " + pass + "\n\n")
	if code, err := qr.Encode(string(b), qr.M); err == nil {
		out.WriteString(qrBlocks(code.Size, code.Black))
	}
	out.WriteString("\nScan the code in the Rclone UI mobile app. Anyone with these can use every\n")
	out.WriteString("remote in this config. Press Ctrl-C to stop.\n\n")
	terminal.WriteString(out.String())
}

// quiet is the light margin around the code, in modules (the QR code's cells).
const quiet = 2

// qrBlocks draws a code with half blocks, two rows of modules per line, dark on light whatever
// the terminal's own colors are.
func qrBlocks(size int, black func(x, y int) bool) string {
	dark := func(x, y int) bool { return black(x-quiet, y-quiet) }
	n := size + 2*quiet
	var b strings.Builder
	for y := 0; y < n; y += 2 {
		b.WriteString(terminal.BlackFg + terminal.HiWhiteBg)
		for x := range n {
			top, bottom := dark(x, y), y+1 < n && dark(x, y+1)
			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}
		b.WriteString(terminal.Reset + "\n")
	}
	return b.String()
}
