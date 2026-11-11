//go:build !production

package assets

import (
	"net/http"
	"os"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Handler serves dist/ from disk, or the folder in RCUI_DIST_DIR. Files are read on every request,
// so a rebuild shows up on reload. When FRONTEND_DEVSERVER_URL is set (Vite on port 9245), Wails
// proxies the dev server instead.
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
