package logs

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/rclone/rclone/fs"
)

// rclone has levels between and above slog's, and its log handler writes them with these
// values. The log shows rclone's records at their own level.
const (
	LevelNotice   = fs.SlogLevelNotice
	LevelCritical = fs.SlogLevelCritical
)

// LevelWord returns the name that the log file and the tail use for a level: debug, info,
// notice, warning, error or critical. Critical also covers rclone's alert and emergency.
func LevelWord(l slog.Level) string {
	switch {
	case l < slog.LevelInfo:
		return "debug"
	case l < LevelNotice:
		return "info"
	case l < slog.LevelWarn:
		return "notice"
	case l < slog.LevelError:
		return "warning"
	case l < LevelCritical:
		return "error"
	}
	return "critical"
}

// ParseLevel reads a level name in the form LevelWord writes, rclone's form (DEBUG … EMERGENCY)
// or slog's (WARN).
func ParseLevel(name string) (slog.Level, error) {
	if l, ok := levelOf(name); ok {
		return l, nil
	}
	return 0, fmt.Errorf("unknown log level %q", name)
}

// levelOf reads the level names that children write: rclone's (debug … emergency), those in
// slog's JSON (DEBUG, INFO, WARN, ERROR) and zerolog's (trace … panic).
func levelOf(name string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "trace", "debug":
		return slog.LevelDebug, true
	case "info":
		return slog.LevelInfo, true
	case "notice":
		return LevelNotice, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error", "err":
		return slog.LevelError, true
	case "critical", "alert", "emergency", "fatal", "panic", "dpanic":
		return LevelCritical, true
	}
	return 0, false
}
