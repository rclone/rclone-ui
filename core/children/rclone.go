package children

import (
	"context"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/rclone/rclone/fs"
)

type Limits struct {
	LogLevel      string
	BwLimit       string
	TPSLimit      float64
	TPSLimitBurst int
	UserAgent     string
}

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

func rcloneArgs(own []string, socketDir, id, configPath, cacheDir string, l Limits) []string {
	args := append([]string{}, own...)
	args = append(args,
		"--config="+configPath,
		"--ask-password=false",
		"--use-json-log",
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
	if cacheDir != "" && ownCacheDir(own) == "" {
		args = append(args, "--cache-dir="+cacheDir)
	}
	// serve http, nfs, sftp and restic would log a block of stats every minute.
	args = append(args, "--stats=0")
	if len(own) == 0 || own[0] != "tunnel" {
		args = append(args, "--rc")
	}
	return append(args, "--rc-addr=unix://"+rcSock(socketDir, id))
}

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

func dropFromChildEnv(key string) bool {
	if runtime.GOOS == "windows" {
		key = strings.ToUpper(key)
	}
	switch {
	case strings.HasPrefix(key, "RCUI_"):
		return true
	case strings.HasPrefix(key, "RCLONE_RC_"):
		return true
	}
	switch key {
	case "RCLONE_CONFIG", "RCLONE_CONFIG_PASS", "RCLONE_PASSWORD_COMMAND":
		return true
	case "RCLONE_LOG_FILE", "RCLONE_SYSLOG", "RCLONE_LOG_SYSTEMD":
		return true
	}
	return false
}

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
