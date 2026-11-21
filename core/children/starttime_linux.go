package children

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
)

// processStartTime returns field 22 of /proc/<pid>/stat, which is the process's start time in
// clock ticks since boot.
func processStartTime(pid int) (int64, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, errNoProcess
	}
	if err != nil {
		return 0, err
	}
	return parseStat(string(b))
}

// parseStat reads the start time from a stat line. The command name is in parentheses and may
// itself contain spaces and parentheses, so the fields are counted after the last ')'.
func parseStat(line string) (int64, error) {
	i := strings.LastIndexByte(line, ')')
	if i < 0 {
		return 0, errors.New("malformed /proc stat line")
	}
	fields := strings.Fields(line[i+1:])
	const startTimeField = 22 - 3 // fields[0] is field 3, the state
	if len(fields) <= startTimeField {
		return 0, errors.New("short /proc stat line")
	}
	return strconv.ParseInt(fields[startTimeField], 10, 64)
}
