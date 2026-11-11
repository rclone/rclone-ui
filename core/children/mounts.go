package children

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// unmountTimeout limits one cleanup command, because a dead mount can make it hang.
const unmountTimeout = 15 * time.Second

// Unmount force-unmounts a broken mount point, trying each command until one succeeds. On Linux
// it tries fusermount3 -uz, fusermount -uz, then umount -l. On macOS it tries umount -f, then
// diskutil unmount force. On Windows it does nothing, because WinFsp removes a mount when its
// process ends.
func Unmount(ctx context.Context, mountPoint string) error {
	var errs []error
	for _, c := range unmountCommands(runtime.GOOS, mountPoint) {
		err := runBounded(ctx, unmountTimeout, c[0], c[1:]...)
		if err == nil {
			return nil
		}
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func unmountCommands(goos, mountPoint string) [][]string {
	switch goos {
	case "linux":
		return [][]string{
			{"fusermount3", "-uz", mountPoint},
			{"fusermount", "-uz", mountPoint},
			{"umount", "-l", mountPoint},
		}
	case "darwin":
		return [][]string{
			{"umount", "-f", mountPoint},
			{"diskutil", "unmount", "force", mountPoint},
		}
	}
	return nil
}

// runBounded runs a command for at most d. A command that is still stuck in the kernel after that
// is abandoned rather than waited for.
func runBounded(ctx context.Context, d time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = time.Second
	type result struct {
		out []byte
		err error
	}
	done := make(chan result, 1)
	go func() {
		out, err := cmd.CombinedOutput()
		done <- result{out, err}
	}()
	select {
	case r := <-done:
		if r.err != nil {
			return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), r.err, strings.TrimSpace(string(r.out)))
		}
		return nil
	case <-time.After(d + 2*time.Second):
		return fmt.Errorf("%s %s: still running after %s", name, strings.Join(args, " "), d)
	}
}

// mountEntry is one line of Linux's /proc/self/mountinfo.
type mountEntry struct {
	Point  string
	FSType string
}

// parseMountinfo reads mountinfo lines (see proc(5)). The mount point is field 5, and the
// filesystem type is the first field after the " - " separator. Spaces and similar characters
// are written as octal escapes.
func parseMountinfo(r io.Reader) ([]mountEntry, error) {
	var out []mountEntry
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		sep := -1
		for i, f := range fields {
			if f == "-" {
				sep = i
				break
			}
		}
		if len(fields) < 5 || sep < 0 || sep+1 >= len(fields) {
			continue
		}
		out = append(out, mountEntry{Point: unescapeMountinfo(fields[4]), FSType: fields[sep+1]})
	}
	return out, sc.Err()
}

func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
