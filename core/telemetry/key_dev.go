//go:build !production

package telemetry

import "os"

// Key is unused in a development build, which sends nothing unless RCUI_TELEMETRY_KEY is set.
var Key = ""

func buildKey() string { return os.Getenv("RCUI_TELEMETRY_KEY") }

func buildHost() string {
	if host := os.Getenv("RCUI_TELEMETRY_HOST"); host != "" {
		return host
	}
	return Host
}
