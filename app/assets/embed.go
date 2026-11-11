//go:build production

package assets

import (
	"embed"
	"io/fs"
	"net/http"
	"time"
)

//go:embed all:dist
var dist embed.FS

func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // can't fail, because the embed directive includes dist
	}
	return newCompressed(sub, time.Now())
}
