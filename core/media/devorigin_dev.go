//go:build !production

package media

import "os"

func devServerURL() string { return os.Getenv("FRONTEND_DEVSERVER_URL") }
