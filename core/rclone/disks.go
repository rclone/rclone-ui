package rclone

import (
	"context"
	"fmt"
)

// Disks lists the local disks and folders shown under Places in the pickers: the root, the home
// folder, mounted volumes and the user's folders. Each one can be used directly as a path. The
// list is only available through rclone's core/disks rc function, because it has no Go API.
func Disks(ctx context.Context) ([]string, error) {
	out, _, err := Call(ctx, "core/disks", nil, CallOpts{})
	if err != nil {
		return nil, err
	}
	disks, ok := out["disks"].([]string)
	if !ok {
		return nil, fmt.Errorf("core/disks: unexpected answer %T", out["disks"])
	}
	return disks, nil
}
