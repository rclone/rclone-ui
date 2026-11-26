package rclone

import (
	"context"
	"fmt"
)

// The list is only available through rclone's core/disks rc function, because it has no Go API.
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
