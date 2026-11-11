//go:build !production

package telemetry

import "os"

// Key is unused in a development build, which sends nothing unless RCUI_TELEMETRY_KEY is set.
var Key = ""

// buildKey returns the key from RCUI_TELEMETRY_KEY, so that a development run sends nothing by
// itself and can be pointed at a test project, or at a local server with RCUI_TELEMETRY_HOST.
func buildKey() string { return os.Getenv("RCUI_TELEMETRY_KEY") }

func buildHost() string {
	if host := os.Getenv("RCUI_TELEMETRY_HOST"); host != "" {
		return host
	}
	return Host
}
