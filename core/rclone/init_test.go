package rclone

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/rclone/rclone/cmd/bisync"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/fshttp"
)

func TestInit(t *testing.T) {
	ci := fs.GetConfig(context.Background())
	if ci.AskPassword || ci.HTTPProxy != "" || ci.MaxStatsGroups != maxStatsGroups {
		t.Errorf("AskPassword %v HTTPProxy %q MaxStatsGroups %d", ci.AskPassword, ci.HTTPProxy, ci.MaxStatsGroups)
	}
	if !strings.HasPrefix(ci.UserAgent, "rclone-ui/") || !strings.HasSuffix(ci.UserAgent, " rclone/"+fs.Version) {
		t.Errorf("UserAgent %q", ci.UserAgent)
	}
	if ci.LogLevel != fs.LogLevelInfo {
		t.Errorf("LogLevel %v, want INFO", ci.LogLevel)
	}
	if got := config.GetConfigPath(); got != configPath || store.Path() != configPath {
		t.Errorf("config path %q, store's %q", got, store.Path())
	}
	if got := os.Getenv("RCLONE_CONFIG_DIR"); got != dataDir {
		t.Errorf("RCLONE_CONFIG_DIR %q", got)
	}
	if got := config.GetCacheDir(); got != filepath.Join(dataDir, "cache") {
		t.Errorf("cache dir %q", got)
	}
	if bisync.DefaultWorkdir != filepath.Join(dataDir, "cache", "bisync") {
		t.Errorf("bisync workdir %q", bisync.DefaultWorkdir)
	}
	if config.Data() != store {
		t.Error("the Store is not rclone's storage")
	}
	if got := config.FileSections(); !slices.Equal(got, []string{"mem"}) {
		t.Errorf("sections %v", got)
	}
	if st := store.State(); st.Status != StatusOK || st.Encrypted || st.Path != configPath {
		t.Errorf("state %+v", st)
	}
	if _, err := Init(context.Background(), InitOptions{ConfigPath: "x", CacheDir: "y"}); err == nil {
		t.Error("a second Init succeeded")
	}
	if _, err := Init(context.Background(), InitOptions{CacheDir: "y"}); err == nil {
		t.Error("Init without a config path succeeded")
	}
}

func TestInitRefusesABadLogLevelFirst(t *testing.T) {
	if _, err := logLevelOf("LOUD"); err == nil || !strings.Contains(err.Error(), "log_level") {
		t.Errorf("a bad level: %v", err)
	}
	// The level is checked before the run-once flag, so even though Init has already run, the
	// error is about the level.
	if _, err := Init(context.Background(), InitOptions{ConfigPath: "x", CacheDir: "y", LogLevel: "LOUD"}); err == nil || !strings.Contains(err.Error(), "log_level") {
		t.Errorf("Init with a bad level: %v", err)
	}
	if level, err := logLevelOf(" DEBUG "); err != nil || level != fs.LogLevelDebug {
		t.Errorf("DEBUG: %v, %v", level, err)
	}
	if level, err := logLevelOf(""); err != nil || level != fs.LogLevelInfo {
		t.Errorf("no setting: %v, %v; want the app's %s", level, err, defaultLogLevel)
	}
}

func TestProxyEnv(t *testing.T) {
	if got := proxyEnv(Proxy{URL: "  "}); got != nil {
		t.Errorf("no proxy: %v", got)
	}
	got := proxyEnv(Proxy{URL: " http://p:3128 ", IgnoredHosts: []string{"a.example", "10.0.0.0/8"}})
	want := map[string]string{
		"HTTP_PROXY": "http://p:3128", "HTTPS_PROXY": "http://p:3128", "http_proxy": "http://p:3128", "https_proxy": "http://p:3128",
		"NO_PROXY": "a.example,10.0.0.0/8", "no_proxy": "a.example,10.0.0.0/8",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if got := proxyEnv(Proxy{URL: "http://p"}); got["NO_PROXY"] != "" || len(got) != 4 {
		t.Errorf("no ignored hosts: %v", got)
	}

	// Init set these in the process, replacing the environment's values.
	if os.Getenv("HTTPS_PROXY") != testProxy.URL || os.Getenv("HTTP_PROXY") != testProxy.URL || os.Getenv("NO_PROXY") != "localhost,10.0.0.0/8" {
		t.Errorf("process environment: HTTPS_PROXY %q NO_PROXY %q (before Init HTTP_PROXY %q, %v)",
			os.Getenv("HTTPS_PROXY"), os.Getenv("NO_PROXY"), operatorHTTP, operatorHas)
	}
}

// Init finishes setting up http.DefaultTransport. Its first use later, such as an httptest
// server's Close or a library cloning it, then writes nothing that could race with a new Fs
// client copying its fields (go test -race).
func TestInitSetsUpTheDefaultTransport(t *testing.T) {
	var wg sync.WaitGroup
	wg.Go(func() { fshttp.NewClient(context.Background()) })
	http.DefaultTransport.(*http.Transport).CloseIdleConnections()
	wg.Wait()
}
