package assets

import (
	"bytes"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

const ZstdSuffix = ".zst"

type loader func(name string) ([]byte, error)

type spa struct {
	load    loader
	modTime time.Time
}

func (s spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	data, err := s.load(name)
	if errors.Is(err, fs.ErrNotExist) && path.Ext(name) == "" {
		name = "index.html"
		data, err = s.load(name)
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		http.NotFound(w, r)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", ContentType(name, data))
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, name, s.modTime, bytes.NewReader(data))
}

// types lists the extensions whose type the OS tables get wrong or don't have. For example, the
// Windows registry may say text/plain for .js, which WebView2 refuses for a module script.
var types = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".gif":         "image/gif",
	".webp":        "image/webp",
	".ico":         "image/x-icon",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
	".ttf":         "font/ttf",
	".otf":         "font/otf",
	".wasm":        "application/wasm",
	".txt":         "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".mp4":         "video/mp4",
	".webm":        "video/webm",
}

func ContentType(name string, data []byte) string {
	ext := strings.ToLower(path.Ext(name))
	if t, ok := types[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return http.DetectContentType(data)
}
