package children

import (
	"errors"

	"golang.org/x/sys/unix"
)

// processStartTime returns when the process started, in microseconds (sysctl kern.proc.pid).
func processStartTime(pid int) (int64, error) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if errors.Is(err, unix.EIO) || errors.Is(err, unix.ESRCH) {
		return 0, errNoProcess // sysctl returns nothing for a missing process
	}
	if err != nil {
		return 0, err
	}
	if int(kp.Proc.P_pid) != pid {
		return 0, errNoProcess
	}
	t := kp.Proc.P_starttime
	return t.Sec*1_000_000 + int64(t.Usec), nil
}
