package rclone

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/rclone/rclone/cmd/bisync"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/lib/oauthutil"

	"github.com/rclone/rclone-ui/core/version"
)

type InitOptions struct {
	ConfigPath string // the active config file, in rclone's own format (Store)
	// ConfigPassword opens an encrypted ConfigPath and comes from the keychain. If it is missing
	// or wrong, the Store reports that it needs a password.
	ConfigPassword string
	CacheDir       string // <data>/cache
	LogLevel       string // "" = INFO
	Proxy          Proxy  // set in the process environment
	// BwLimit is the bandwidth limit from Settings. SetBwLimit changes it while rclone runs.
	BwLimit fs.BwPair
}

// Proxy is the proxy from Settings. rclone, the child processes and the app's own HTTP clients
// (httpx) all find it through the environment.
type Proxy struct {
	URL          string
	IgnoredHosts []string
}

// maxStatsGroups is the number of stats groups that rclone keeps. Past this limit, it drops the
// oldest, which could belong to a long transfer. The app deletes every group it creates once
// the group's work ends.
const maxStatsGroups = 100000

// defaultLogLevel is used when Settings has no log level. rclone's own default, NOTICE, leaves
// out the per-file lines, which are what people look for in the log files and at the end of a
// bug report.
const defaultLogLevel = "INFO"

var initialised atomic.Bool

// Init sets up rclone's process-wide state and opens the active config file. It runs once,
// before any service uses rclone, and after the log handler is installed (rclonelog.Install).
// If the log level is invalid, rclone is left untouched, so Init can be called again with
// another level. A config file that can't be read isn't an error here. The Store's State
// reports it instead.
func Init(ctx context.Context, o InitOptions) (*Store, error) {
	if o.ConfigPath == "" || o.CacheDir == "" {
		return nil, errors.New("rclone: Init needs a config path and a cache dir")
	}
	level, err := logLevelOf(o.LogLevel)
	if err != nil {
		return nil, err
	}
	if !initialised.CompareAndSwap(false, true) {
		return nil, errors.New("rclone: Init runs once per process")
	}

	// This must happen before any HTTP request, because Go reads these variables only once
	// per process.
	setProxyEnv(o.Proxy)
	// net/http finishes setting up http.DefaultTransport (its TLS and HTTP/2 fields) on first
	// use. rclone copies that transport's fields without a lock for every new Fs client
	// (fshttp.NewTransportCustom). Finishing the setup here, before any Fs exists, prevents a race
	// with a first use elsewhere, such as a library cloning it, or a test's http.Get or
	// httptest server.
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		t.CloseIdleConnections()
	}

	// Read rclone's own default config path before the app's path replaces it.
	if _, err := DefaultConfigPath(); err != nil {
		return nil, fmt.Errorf("rclone: default config path: %w", err)
	}
	if err := EnsurePortableConfig(); err != nil {
		return nil, fmt.Errorf("rclone: portable config: %w", err)
	}
	// config.SetData is ignored when no path is set (config.go:337-343), so set the path first.
	abs, err := filepath.Abs(o.ConfigPath)
	if err != nil {
		return nil, fmt.Errorf("rclone: config path: %w", err)
	}
	if err := config.SetConfigPath(abs); err != nil {
		return nil, fmt.Errorf("rclone: config path: %w", err)
	}

	// These are set as fields so that the compiler checks them when rclone is upgraded. The
	// Reload call below applies them (fs.LogReload applies the level).
	ci := fs.GetConfig(context.Background())
	ci.AskPassword = false // nothing may prompt for input on the terminal
	ci.UserAgent = fmt.Sprintf("rclone-ui/%s rclone/%s", version.App, fs.Version)
	ci.MaxStatsGroups = maxStatsGroups
	// When HTTPProxy is set, rclone sends every request to that proxy, ignores NO_PROXY and
	// proxies loopback addresses too (fs/fshttp/http.go). The proxy is set in the environment
	// instead.
	ci.HTTPProxy = ""
	ci.LogLevel = level
	ci.BwLimit = bwTimetable(o.BwLimit)
	if err := ci.Reload(ctx); err != nil {
		return nil, fmt.Errorf("rclone: options: %w", err)
	}
	if err := config.SetCacheDir(o.CacheDir); err != nil {
		return nil, fmt.Errorf("rclone: cache dir: %w", err)
	}
	// bisync sets this at init from the default cache dir, so set it again here.
	bisync.DefaultWorkdir = filepath.Join(config.GetCacheDir(), "bisync")
	// rclone never opens a browser itself. The ui opens the config session's URL instead
	// (config sessions also set config_auth_no_browser).
	oauthutil.OpenURL = func(string) error { return nil }

	// This comes after AskPassword is turned off, so an encrypted file never prompts on the
	// terminal. The file is loaded now so that a broken file shows up at start, not at the
	// first request.
	store := NewStore()
	if err := store.Open(abs, o.ConfigPassword); err != nil {
		return nil, err
	}

	// This comes after the options are set, because the token bucket reads the bandwidth limit
	// here. Start also starts the TPS limiter and turns on error counting.
	accounting.Start(ctx)
	return store, nil
}

func logLevelOf(s string) (fs.LogLevel, error) {
	var level fs.LogLevel
	if err := level.Set(orDefault(s, defaultLogLevel)); err != nil {
		return level, fmt.Errorf("rclone: log_level: %w", err)
	}
	return level, nil
}

func orDefault(s, def string) string {
	if s = strings.TrimSpace(s); s != "" {
		return s
	}
	return def
}

// proxyEnv returns the environment variables for proxy p. It returns nothing when no proxy is
// set, which leaves the app's starting environment as it is, so a system or shell proxy keeps
// working.
func proxyEnv(p Proxy) map[string]string {
	u := strings.TrimSpace(p.URL)
	if u == "" {
		return nil
	}
	env := map[string]string{"HTTP_PROXY": u, "HTTPS_PROXY": u, "http_proxy": u, "https_proxy": u}
	if len(p.IgnoredHosts) > 0 {
		joined := strings.Join(p.IgnoredHosts, ",")
		env["NO_PROXY"], env["no_proxy"] = joined, joined
	}
	return env
}

// setProxyEnv sets the proxy from Settings in the process environment. It sets both upper- and
// lowercase names, because tools differ in which ones they read. A saved proxy replaces the
// environment's. When none is saved, the environment's proxy applies. Go reads these variables
// once per process, so a change needs an app restart.
func setProxyEnv(p Proxy) {
	for k, v := range proxyEnv(p) {
		_ = os.Setenv(k, v)
	}
}

// bwTimetable is rclone's --bwlimit option for a single limit. An unset limit is no timetable.
func bwTimetable(limit fs.BwPair) fs.BwTimetable {
	if !limit.IsSet() {
		return nil
	}
	return fs.BwTimetable{{Bandwidth: limit}}
}

// SetBwLimit changes the bandwidth limit while rclone runs, as rclone's core/bwlimit does. The
// transfers that are running slow down or speed up at once. The children that start later get it
// too (children.ParentLimits). It needs Init to have run.
func SetBwLimit(limit fs.BwPair) {
	fs.GetConfig(context.Background()).BwLimit = bwTimetable(limit)
	accounting.TokenBucket.SetBwLimit(limit)
}
