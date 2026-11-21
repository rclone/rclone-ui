// Command rclonetext prints the English text of the rclone that is linked into Rclone UI, as
// core/catalog reads it (catalog.EnglishTexts): a JSON object from each key, with its parts
// joined by "\u0000", to its text. `go run ./build/i18n -rclone` runs it and writes
// locales/en/rclone.json from its output. It is a command of its own so that build/i18n, which
// `npm run i18n` and the checks run, doesn't link all of rclone.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	_ "github.com/rclone/rclone/backend/all" // every backend, as main.go imports them
	_ "github.com/rclone/rclone/cmd/all"     // every command, with the mount and serve option blocks

	"github.com/rclone/rclone-ui/core/catalog"
)

func main() {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(catalog.EnglishTexts()); err != nil {
		fmt.Fprintln(os.Stderr, "rclonetext:", err)
		os.Exit(1)
	}
}
