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
	ConfigPath     string
	ConfigPassword string
	CacheDir       string
	LogLevel       string
	Proxy          Proxy
	BwLimit        fs.BwPair
}

type Proxy struct {
	URL          string
	IgnoredHosts []string
}

const maxStatsGroups = 100000

const defaultLogLevel = "INFO"

var initialised atomic.Bool

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

	ci := fs.GetConfig(context.Background())
	ci.AskPassword = false
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
	oauthutil.OpenURL = func(string) error { return nil }

	// This comes after AskPassword is turned off, so an encrypted file never prompts on the
	// terminal.
	store := NewStore()
	if err := store.Open(abs, o.ConfigPassword); err != nil {
		return nil, err
	}

	// This comes after the options are set, because the token bucket reads the bandwidth limit
	// here.
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

func setProxyEnv(p Proxy) {
	for k, v := range proxyEnv(p) {
		_ = os.Setenv(k, v)
	}
}

func bwTimetable(limit fs.BwPair) fs.BwTimetable {
	if !limit.IsSet() {
		return nil
	}
	return fs.BwTimetable{{Bandwidth: limit}}
}

func SetBwLimit(limit fs.BwPair) {
	fs.GetConfig(context.Background()).BwLimit = bwTimetable(limit)
	accounting.TokenBucket.SetBwLimit(limit)
}
