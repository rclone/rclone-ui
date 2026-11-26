package app

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/rclone/rclone-ui/core/agents"
	"os"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/app/autostart"
	"github.com/rclone/rclone-ui/app/launcher/view/linux"
	"github.com/rclone/rclone-ui/app/pathlink"
	"github.com/rclone/rclone-ui/app/windows"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/rclone"
)

func (u *ui) services() []application.Service {
	return append([]application.Service{
		service(u, &WindowService{u: u}),
		service(u, &LauncherService{u: u}),
		service(u, &linux.PageService{View: func() *linux.View { return u.launcher.Page() }}),
		service(u, &CoreService{u: u}),
		service(u, &SystemService{u: u}),
		service(u, &DialogService{u: u}),
		service(u, &UpdateService{u: u}),
		service(u, &PathService{u: u}),
		service(u, &AgentsService{u: u}),
		service(u, u.apis.Prefs),
		service(u, u.apis.Settings),
		service(u, u.apis.Favorites),
		service(u, u.apis.Templates),
		service(u, u.apis.Launcher),
		service(u, u.apis.Logs),
		service(u, u.apis.Vfs),
		service(u, u.apis.Media),
		service(u, u.apis.Files),
		service(u, u.apis.Catalog),
		service(u, u.apis.Config),
		service(u, u.apis.Remotes),
		service(u, u.apis.Mounts),
		service(u, u.apis.Serves),
		service(u, u.apis.Tunnel),
		service(u, u.apis.Notifications),
		service(u, u.apis.Browse),
		service(u, u.apis.Transfers),
		service(u, u.apis.Watchers),
		service(u, u.apis.Schedules),
		service(u, u.apis.Links),
		service(u, u.apis.Telemetry),
		service(u, u.apis.App),
	}, u.devServices()...)
}

// Wails ignores the app-wide error marshaller for a service's methods, so each service sets one.
func service[T any](u *ui, api *T) application.Service {
	return application.NewServiceWithOptions(api, application.ServiceOptions{MarshalError: u.marshalError})
}

func (u *ui) marshalError(err error) []byte {
	e := rclone.ErrorOf(err)
	switch e.Code {
	case errs.CodeInternal:
		u.log.Error("a call failed", "code", string(e.Code), "error", err)
	case errs.CodeFailed:
		u.log.Warn("a call failed", "code", string(e.Code), "error", err)
	}
	b, jerr := json.Marshal(e.Localized())
	if jerr != nil {
		return nil // Wails then marshals the error itself
	}
	return b
}

type WindowService struct{ u *ui }

// Open opens the window for a route, such as "/remotes?action=create". The route decides the
// window's name and size. If a window with that name is already open, it is focused and switches
// to the route.
func (s *WindowService) Open(url string) error { return s.u.windows.Open(url) }

var errNoCaller = errors.New("the call didn't come from a window")

// SetTheme sets the calling window's appearance: "dark", "light", or "" to follow the system.
func (s *WindowService) SetTheme(ctx context.Context, theme string) error {
	w, ok := windows.Caller(ctx)
	if !ok {
		return errNoCaller
	}
	s.u.windows.SetTheme(w, theme)
	return nil
}

// GuardClose sets whether closing the calling window asks its page first, which the page does
// while it holds unsaved changes. The page gets the window:close event, asks, and closes the
// window itself.
func (s *WindowService) GuardClose(ctx context.Context, on bool) {
	if w, ok := windows.Caller(ctx); ok {
		s.u.windows.GuardClose(w.Name(), on)
	}
}

type LauncherService struct{ u *ui }

func (s *LauncherService) Show() { s.u.launcher.Show() }

// SetShortcut replaces the launcher's global shortcut. It uses the syntax that Settings stores,
// such as "CmdOrCtrl+Shift+/", and "" removes the shortcut.
func (s *LauncherService) SetShortcut(shortcut string) error {
	return s.u.launcher.SetShortcut(strings.TrimSpace(shortcut))
}

type CoreService struct{ u *ui }

func (s *CoreService) Status() CoreStatus { return s.u.coreStatus() }

type SystemService struct{ u *ui }

// SystemInfo holds the facts about the machine that bug reports include.
type SystemInfo struct {
	// OS is Go's name for the OS ("darwin").
	OS string `json:"os"`
	// OSName and OSVersion describe the OS ("macOS", "15.2").
	OSName    string `json:"osName"`
	OSVersion string `json:"osVersion"`
	// Shell is the desktop shell and its version ("Wails v3.1.0").
	Shell string `json:"shell"`
}

func (s *SystemService) Info() SystemInfo {
	var osName, osVersion string
	if env := s.u.app.Env.Info(); env.OSInfo != nil {
		osName, osVersion = env.OSInfo.Name, env.OSInfo.Version
	}
	return SystemInfo{OS: runtime.GOOS, OSName: osName, OSVersion: osVersion, Shell: shellVersion()}
}

func shellVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range bi.Deps {
			if dep.Path == "github.com/wailsapp/wails/v3" {
				return "Wails " + dep.Version
			}
		}
	}
	return "Wails"
}

func (s *SystemService) RevealPath(path string) error { return s.u.reveal(path, true) }

func (s *SystemService) OpenURL(url string) error { return s.u.openURL(url) }

// Autostart reports whether the app starts at login.
func (s *SystemService) Autostart() (bool, error) { return autostart.IsEnabled(s.u.app) }

// SetAutostart turns starting at login on or off, and tells every window (EventAutostartChanged),
// so that the switch in another window follows.
func (s *SystemService) SetAutostart(enabled bool) error {
	var err error
	if enabled {
		err = autostart.Enable(s.u.app)
	} else {
		err = autostart.Disable(s.u.app)
	}
	if err != nil {
		return err
	}
	s.u.app.Event.Emit(EventAutostartChanged, enabled)
	return nil
}

// Log writes a page's console line to the UI's log. level is the console method that was called.
func (s *SystemService) Log(level, window, message string) {
	l := s.u.log.With("src", "page", "window", window)
	switch level {
	case "error":
		l.Error(message)
	case "warn":
		l.Warn(message)
	case "debug", "log", "trace":
		l.Debug(message)
	default:
		l.Info(message)
	}
}

// Quit runs the quit flow, which first checks whether anything is busy.
func (s *SystemService) Quit() { go s.u.quit(false) }

// Relaunch starts the app again and reopens the window at open ("" for none). Whatever is running
// stops and comes back, as it does after a quit. When something is running, the user is asked
// first, and Relaunch returns false if they keep the app running.
func (s *SystemService) Relaunch(ctx context.Context, open string) bool {
	// i18n: The title and the button of the dialog that asks before a restart stops what is running.
	if !s.u.confirmStop(ctx, i18n.T("Restart"), i18n.T("Restart")) {
		return false
	}
	go s.u.relaunch(open)
	return true
}

// DialogService saves the text that a page exports.
type DialogService struct{ u *ui }

type SaveOptions struct {
	Title string `json:"title"`
	// Directory is the folder the dialog opens in, and Filename is the name it suggests.
	Directory string                   `json:"directory"`
	Filename  string                   `json:"filename"`
	Filters   []application.FileFilter `json:"filters"`
}

// SaveText asks where to save, in a dialog over the calling window, and writes contents there. It
// returns the path, or "" when the user cancelled.
func (s *DialogService) SaveText(ctx context.Context, o SaveOptions, contents string) (string, error) {
	opts := &application.SaveFileDialogOptions{
		Title:                o.Title,
		Directory:            o.Directory,
		Filename:             o.Filename,
		Filters:              o.Filters,
		CanCreateDirectories: true,
	}
	if w, ok := windows.Caller(ctx); ok {
		opts.Window = w
	}
	path, err := s.u.app.Dialog.SaveFileWithOptions(opts).PromptForSingleSelection()
	if err != nil || path == "" {
		return "", err
	}
	if err := writePrivate(path, contents); err != nil {
		return "", err
	}
	return path, nil
}

// Chmod always fails on Windows, where the file takes its folder's permissions.
func writePrivate(path, contents string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if err := f.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		_ = f.Close()
		return err
	}
	if _, err := f.WriteString(contents); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

type AgentsService struct{ u *ui }

type AgentsInfo struct {
	agents.Status
	// Command is this app's executable, which a client that starts a command runs as
	// `<command> mcp`.
	Command string `json:"command"`
}

// Status returns whether the server runs and where, and the command for clients that start one.
// EventAgentsChanged follows each change of the status.
func (s *AgentsService) Status() AgentsInfo {
	return AgentsInfo{Status: s.u.agents.Status(), Command: s.u.exe}
}

type PathService struct{ u *ui }

func (s *PathService) Status() (pathlink.State, error) { return pathlink.Status() }

// Enable adds rclone to PATH. On macOS, it asks for an administrator password when
// /usr/local/bin requires one.
func (s *PathService) Enable() (pathlink.State, error) { return s.changed(pathlink.Enable()) }

func (s *PathService) Disable() (pathlink.State, error) { return s.changed(pathlink.Disable()) }

func (s *PathService) changed(st pathlink.State, err error) (pathlink.State, error) {
	if err == nil {
		s.u.app.Event.Emit(EventPathLinkChanged, st)
	}
	return st, err
}
