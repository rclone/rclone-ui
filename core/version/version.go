// Package version reports the app's version and the version of the rclone it embeds.
package version

import "github.com/rclone/rclone/fs"

// App is the app's version, set at build time with
// -ldflags "-X github.com/rclone/rclone-ui/core/version.App=v4.0.0".
var App = "dev"

// Rclone returns the embedded rclone's version (fs.Version, which ldflags also sets in a release
// build).
func Rclone() string { return fs.Version }
