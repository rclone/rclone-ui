package children

import "context"

// brokenMounts always returns nil, because WinFsp removes a mount when its process ends.
func brokenMounts(context.Context, []Record, []string) []string { return nil }

func MountPoints() ([]string, error) { return nil, nil }

// OwnMount returns nil, because WinFsp removes a mount when its process ends.
func OwnMount(string) func() { return nil }
