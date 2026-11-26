//go:build !production

package assets

import (
	"net/http"
	"os"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// When FRONTEND_DEVSERVER_URL is set, Wails proxies the dev server instead.
func Handler() http.Handler {
	if os.Getenv("FRONTEND_DEVSERVER_URL") != "" {
		return application.AssetFileServerFS(os.DirFS("."))
	}
	dir := os.Getenv("RCUI_DIST_DIR")
	if dir == "" {
		dir = "dist"
	}
	tree := os.DirFS(dir)
	return spa{load: func(name string) ([]byte, error) { return readFile(tree, name) }, modTime: time.Now()}
}
