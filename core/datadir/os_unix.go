//go:build !windows

package datadir

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

func tryLock(f *os.File) (bool, error) {
	err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) {
		return false, nil
	}
	return err == nil, err
}

func unlock(f *os.File) { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN) }

func uidPrefix() string { return strconv.Itoa(os.Getuid()) + "-" }

func ownPrivateDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("not a directory")
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return fmt.Errorf("owned by uid %d, not by this user", st.Uid)
	}
	if info.Mode().Perm() != 0o700 {
		return os.Chmod(dir, 0o700)
	}
	return nil
}
