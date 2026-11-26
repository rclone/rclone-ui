package main

import (
	"encoding/json"
	"fmt"
	"os"

	_ "github.com/rclone/rclone/backend/all"
	_ "github.com/rclone/rclone/cmd/all"

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
