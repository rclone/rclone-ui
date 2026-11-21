//go:build production

package telemetry

// Key is the PostHog project key that a release is built with:
// -ldflags "-X github.com/rclone/rclone-ui/core/telemetry.Key=phc_…" (build/build.sh sets it from
// POSTHOG_KEY). It only lets a sender add events to the project, so it isn't a secret. A build
// without it sends nothing.
var Key = ""

func buildKey() string  { return Key }
func buildHost() string { return Host }
