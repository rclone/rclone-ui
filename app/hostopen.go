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

// openURL opens a URL in the default browser. Under an AppImage, xdg-open runs in the host's
// environment (see platform.HostCommand), because the browser it starts would fail with the
// AppImage's libraries.
func (u *ui) openURL(raw string) error {
	if err := browsable(raw); err != nil {
		return err
	}
	if platform.AppDir() != "" {
		return hostOpen(raw)
	}
	return u.app.Browser.OpenURL(raw)
}

// browsable accepts only web and mail links. open, xdg-open and Windows' FileProtocolHandler can
// also run programs and open files, and they read a leading "-" as an option. The URLs that pages
// open aren't all constants. For example, the URL for an OAuth step comes from the core.
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

// reveal shows a file or folder in the file manager, selected when selectFile is set. A folder is
// opened rather than selected, because Wails selects only files. The exception is a bundle on
// macOS (such as an .app), which `open` would launch, so it is selected in its parent folder.
// Under an AppImage, the host's xdg-open opens the folder (or a file's parent folder) with nothing
// selected.
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

// maybeBundle reports whether path is a folder that macOS may treat as a bundle, such as an app
// or a preference pane. That is any folder whose name has an extension. A plain folder with such a
// name is then shown in its parent rather than opened, which is harmless.
func maybeBundle(path string) bool {
	st, err := os.Stat(path)
	if err != nil || !st.IsDir() {
		return false
	}
	name := filepath.Base(filepath.Clean(path))
	ext := filepath.Ext(name)
	return ext != "" && ext != name
}

// hostOpen runs the host's xdg-open on target without waiting for it, because xdg-open may wait
// for the program it starts.
func hostOpen(target string) error {
	cmd := platform.HostCommand(context.Background(), "xdg-open", target)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
