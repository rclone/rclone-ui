//go:build unix

package rclone

import (
	// serve nfs, and so its option block, exists only on Unix (its files are //go:build unix).
	_ "github.com/rclone/rclone/cmd/serve/nfs"
)
