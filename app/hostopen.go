package app

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode"

	"github.com/rclone/rclone-ui/app/platform"
)

// Under an AppImage, a browser that xdg-open starts would fail with the AppImage's libraries.
func (u *ui) openURL(raw string) error {
	if err := browsable(raw); err != nil {
		return err
	}
	if platform.AppDir() != "" {
		return hostOpen(raw)
	}
	return u.app.Browser.OpenURL(raw)
}

// open, xdg-open and Windows' FileProtocolHandler can also run programs and open files, and
// they read a leading "-" as an option.
func browsable(raw string) error {
	if strings.HasPrefix(raw, "-") || strings.ContainsFunc(raw, unicode.IsControl) {
		return fmt.Errorf("not a URL the browser may open: %q", raw)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("not a URL the browser may open: %w", err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		if u.Host == "" {
			return fmt.Errorf("not a URL the browser may open: %q has no host", raw)
		}
	case "mailto":
	default:
		return fmt.Errorf("not a URL the browser may open: %q", raw)
	}
	return nil
}

// Wails never selects a folder, it opens it. On macOS, opening a bundle (such as an .app) would
// launch it.
func (u *ui) reveal(path string, selectFile bool) error {
	if platform.AppDir() != "" {
		dir := path
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			dir = filepath.Dir(path)
		}
		return hostOpen(dir)
	}
	if selectFile && runtime.GOOS == "darwin" && maybeBundle(path) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		abs, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		return exec.CommandContext(ctx, "open", "-R", abs).Run()
	}
	return u.app.Env.OpenFileManager(path, selectFile)
}

func maybeBundle(path string) bool {
	st, err := os.Stat(path)
	if err != nil || !st.IsDir() {
		return false
	}
	name := filepath.Base(filepath.Clean(path))
	ext := filepath.Ext(name)
	return ext != "" && ext != name
}

// xdg-open may wait for the program it starts.
func hostOpen(target string) error {
	cmd := platform.HostCommand(context.Background(), "xdg-open", target)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
