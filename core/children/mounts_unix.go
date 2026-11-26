//go:build linux || darwin

package children

import "context"

// rclone registers its own unmount only once the mount is set up, a moment after the mount table
// lists it. A child that ends in between would leave the mount behind.
func OwnMount(mountPoint string) func() {
	if was, err := Mounted(mountPoint); err != nil || was {
		return nil
	}
	return func() {
		if ok, _ := Mounted(mountPoint); ok {
			_ = Unmount(context.Background(), mountPoint)
		}
	}
}
