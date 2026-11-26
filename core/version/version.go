package version

import "github.com/rclone/rclone/fs"

// App is the app's version, set at build time with
// -ldflags "-X github.com/rclone/rclone-ui/core/version.App=v4.0.0".
var App = "dev"

func Rclone() string { return fs.Version }
