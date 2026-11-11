package children

import "context"

// brokenMounts always returns nil, because WinFsp removes a mount when its process ends. The
// mounts service checks whether a mount is there itself (core/mounts).
func brokenMounts(context.Context, []Record, []string) []string { return nil }

// MountPoints returns nothing on Windows, where each disk is a drive of its own.
func MountPoints() ([]string, error) { return nil, nil }

// OwnMount returns nil, because WinFsp removes a mount when its process ends.
func OwnMount(string) func() { return nil }
