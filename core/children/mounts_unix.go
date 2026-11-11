//go:build linux || darwin

package children

import "context"

// OwnMount runs in a mount child as it starts. It returns a function that unmounts mountPoint if
// the child is about to exit and its mount is still there.
//
// rclone registers its own unmount only once the mount is set up, a moment after the mount table
// lists it. A child that ends in between would leave the mount behind. A mount point that was
// already mounted when the child started isn't this child's, so it is left alone.
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
