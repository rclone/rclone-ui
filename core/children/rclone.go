package children

import (
	"context"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/rclone/rclone/fs"
)

// Limits are the options that every rclone child starts with. They copy the core's values at the
// moment the child starts. An empty string or 0 leaves the flag out.
type Limits struct {
	LogLevel      string
	BwLimit       string
	TPSLimit      float64
	TPSLimitBurst int
	UserAgent     string
}

// ParentLimits reads the limits from this process's rclone options. rclone.Init sets them there,
// and so does every change made while the app runs.
func ParentLimits() Limits {
	ci := fs.GetConfig(context.Background())
	return Limits{
		LogLevel:      ci.LogLevel.String(),
		BwLimit:       ci.BwLimit.String(),
		TPSLimit:      ci.TPSLimit,
		TPSLimitBurst: ci.TPSLimitBurst,
		UserAgent:     ci.UserAgent,
	}
}

func rcSock(socketDir, id string) string { return filepath.Join(socketDir, "c-"+id+".sock") }

// rcloneArgs returns a rclone child's command line after the executable. It starts with the
// child's own arguments (from operations.MountCommand or ServeCommand), followed by the flags
// that every child gets. The proxy is not passed as a flag, because the child inherits it through
// the environment.
func rcloneArgs(own []string, socketDir, id, configPath, cacheDir string, l Limits) []string {
	args := append([]string{}, own...)
	args = append(args,
		"--config="+configPath,
		"--ask-password=false",
		"--use-json-log", // written to stderr, which the parent reads
	)
	if l.LogLevel != "" {
		args = append(args, "--log-level="+l.LogLevel)
	}
	if l.BwLimit != "" {
		args = append(args, "--bwlimit="+l.BwLimit)
	}
	if l.TPSLimit > 0 {
		args = append(args, "--tpslimit="+strconv.FormatFloat(l.TPSLimit, 'g', -1, 64))
		if l.TPSLimitBurst > 0 {
			args = append(args, "--tpslimit-burst="+strconv.Itoa(l.TPSLimitBurst))
		}
	}
	if l.UserAgent != "" {
		args = append(args, "--user-agent="+l.UserAgent)
	}
	// A mount or serve already has its own stable --cache-dir in its arguments. Any other child
	// keeps its cache in the data dir as well.
	if cacheDir != "" && ownCacheDir(own) == "" {
		args = append(args, "--cache-dir="+cacheDir)
	}
	// serve http, nfs, sftp and restic would log a block of stats every minute. The core reads
	// each child's core/stats itself instead.
	args = append(args, "--stats=0")
	if len(own) == 0 || own[0] != "tunnel" { // the tunnel serves its own rc and rejects --rc
		args = append(args, "--rc")
	}
	return append(args, "--rc-addr=unix://"+rcSock(socketDir, id))
}

// ownCacheDir returns the --cache-dir in a child's own arguments, or "" when there is none.
func ownCacheDir(own []string) string {
	for i, a := range own {
		if v, ok := strings.CutPrefix(a, "--cache-dir="); ok {
			return v
		}
		if a == "--cache-dir" && i+1 < len(own) {
			return own[i+1]
		}
	}
	return ""
}

// dropFromChildEnv reports whether a rclone child should not inherit the core's variable key.
func dropFromChildEnv(key string) bool {
	if runtime.GOOS == "windows" {
		key = strings.ToUpper(key)
	}
	switch {
	case strings.HasPrefix(key, "RCUI_"): // the app's own variables (childenv adds the child's)
		return true
	case strings.HasPrefix(key, "RCLONE_RC_"): // the core sets up the child's rc
		return true
	}
	switch key {
	case "RCLONE_CONFIG", "RCLONE_CONFIG_PASS", "RCLONE_PASSWORD_COMMAND": // set by --config
		return true
	case "RCLONE_LOG_FILE", "RCLONE_SYSLOG", "RCLONE_LOG_SYSTEMD": // logs go to the core on stderr
		return true
	}
	return false
}

// rcloneEnv returns the core's environment, filtered for a rclone child, with the child's own
// variables added.
func rcloneEnv(base []string, add ...string) []string {
	env := make([]string, 0, len(base)+len(add))
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if !dropFromChildEnv(k) {
			env = append(env, kv)
		}
	}
	return append(env, add...)
}
