package children

import (
	"errors"

	"golang.org/x/sys/windows"
)

// processStartTime returns the process's creation time (GetProcessTimes), in 100 ns units. A
// process that has exited counts as gone, even while an open handle keeps its object alive.
func processStartTime(pid int) (int64, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return 0, errNoProcess
	}
	if err != nil {
		return 0, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return 0, err
	}
	const stillActive = 259
	if code != stillActive {
		return 0, errNoProcess
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return 0, err
	}
	return int64(created.HighDateTime)<<32 | int64(created.LowDateTime), nil
}
