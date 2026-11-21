//go:build !production

package media

import "os"

// devServerURL is Vite's address in a development run. Wails proxies the pages to it and loads
// them on its port, as Wails itself reads it (FRONTEND_DEVSERVER_URL).
func devServerURL() string { return os.Getenv("FRONTEND_DEVSERVER_URL") }
