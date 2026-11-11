// Package app is the UI role. It is the Wails application that owns the windows, the launcher, the
// tray, the menus, deep links, the single-instance lock, autostart, notifications and the update
// flow. It also runs the core inside the same process (see core.go). Pages call it through the
// bound services in services.go, which lib/shell wraps.
//
// The tray is created before the app runs, and the launcher right after it, both before the core
// starts. That way a failed boot always leaves the user a way to quit.
package app

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/rclone/rclone-ui/app/assets"
	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/deeplink"
	"github.com/rclone/rclone-ui/app/interaction"
	"github.com/rclone/rclone-ui/app/launcher"
	"github.com/rclone/rclone-ui/app/launcher/engine/providers"
	"github.com/rclone/rclone-ui/app/launcher/host"
	"github.com/rclone/rclone-ui/app/launcher/view/linux/gnome"
	"github.com/rclone/rclone-ui/app/menus"
	"github.com/rclone/rclone-ui/app/pathlink"
	"github.com/rclone/rclone-ui/app/platform"
	"github.com/rclone/rclone-ui/app/tray"
	"github.com/rclone/rclone-ui/app/update"
	"github.com/rclone/rclone-ui/app/windows"
	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/agents"
	"github.com/rclone/rclone-ui/core/datadir"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/telemetry"
	"github.com/rclone/rclone-ui/core/version"
)

//go:embed appicon.png
var appIcon []byte

// appID is the name the OS knows the app by. It is the GTK application ID and the base of the
// single-instance lock's name. Under Flatpak it must be the Flatpak app ID, because the sandbox
// only lets the app own D-Bus names under that ID.
func appID() string {
	if id := os.Getenv("FLATPAK_ID"); id != "" {
		return id
	}
	return "org.rclone.ui"
}

// uniqueID is the name of the single-instance lock. There is one lock per data directory, so a
// copy on another data directory (--data-dir) doesn't hand its launch over to the installed app
// and doesn't receive that app's links. The copy on sharedDir, the OS's default data directory,
// takes the app's ID. A portable copy passes no sharedDir, so it never shares a lock.
func uniqueID(dataDir, sharedDir string) string {
	id := appID()
	if dataDir == "" {
		return id
	}
	key := func(dir string) string {
		if abs, err := filepath.Abs(dir); err == nil {
			dir = abs
		}
		dir = filepath.Clean(dir)
		if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
			dir = strings.ToLower(dir) // file systems on these OSes ignore case
		}
		return dir
	}
	dir := key(dataDir)
	if sharedDir != "" && dir == key(sharedDir) {
		return id
	}
	sum := sha256.Sum256([]byte(dir))
	// An element of a D-Bus name can't start with a digit.
	return id + ".d" + hex.EncodeToString(sum[:8])
}

// options are the flags of `rcui ui`, plus an optional rclone:// link.
type options struct {
	dataDir string
	hidden  bool
	link    string
	// open is a route to open in a window right away, as in `rcui ui --open /test`. A relaunch
	// uses it to reopen the window that asked for the relaunch.
	open string
	// after is the ID of a process to wait for before starting. A relaunch sets it to the process
	// it replaces, which holds the single-instance lock and the data folder until it exits.
	after int
}

func parseOptions(args []string) (options, error) {
	var o options
	fs := flag.NewFlagSet("rcui ui", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&o.dataDir, "data-dir", "", "the data directory (default: the core's)")
	fs.BoolVar(&o.hidden, "hidden", false, "start without the startup window")
	fs.StringVar(&o.open, "open", "", "open a window at this route")
	fs.IntVar(&o.after, "after", 0, "wait for this process to exit first")
	// macOS passes -psn_<serial> to an app started by a quarantined first launch. It isn't one of
	// our flags, and parsing it would make the app exit.
	args = slices.DeleteFunc(slices.Clone(args), func(a string) bool { return strings.HasPrefix(a, "-psn_") })
	var rest []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return o, err
		}
		args = fs.Args()
		if len(args) == 0 {
			break
		}
		// This is a link or a stray argument. Skip it and keep parsing.
		rest = append(rest, args[0])
		args = args[1:]
	}
	o.link = deeplink.FromArgs(rest)
	return o, nil
}

type ui struct {
	app        *application.App
	log        *slog.Logger
	logs       *logs.Log
	opts       options
	dataDir    string
	exe        string
	production bool

	windows  *windows.Manager
	launcher *host.Host
	tray     *tray.Tray
	// store is the one copy of the core's state that the tray and the launcher show.
	store    *corestate.Store
	notifier *notifier
	updates  *updateFlow

	cores coreHost
	// apis are the core's APIs that pages call. They are bound before the core starts.
	apis *core.APIs
	// agents is the MCP server that lets AI agents use the app, while the settings turn it on.
	agents *agents.Server

	quitMu   sync.Mutex
	quitting atomic.Bool
	// sessionEnding is set when the OS is ending the session (a logout, a restart or a shutdown)
	// and the app has agreed to let it end (see shouldQuit and wndProc).
	sessionEnding atomic.Bool

	links links

	startupOnce sync.Once
	noStartup   atomic.Bool
	firstReady  sync.Once

	applied uiSettings // the core's settings as the UI last applied them
}

// Run runs the UI role and returns the process's exit code.
func Run(args []string) int {
	opts, err := parseOptions(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rcui ui:", err)
		return 2
	}
	if opts.after > 0 {
		platform.WaitForExit(opts.after, time.Minute)
	}
	u := &ui{opts: opts, production: production}
	if err := u.setup(); err != nil {
		fmt.Fprintln(os.Stderr, "rcui ui:", err)
		return 1
	}
	defer func() { _ = u.logs.Close() }()
	if err := u.app.Run(); err != nil {
		u.log.Error("the app stopped", "error", err)
		return 1
	}
	return 0
}

func (u *ui) setup() error {
	platform.FixPath()
	linuxEnvironment()

	defaultDir, err := datadir.Default()
	u.dataDir = u.opts.dataDir
	if u.dataDir == "" {
		if err != nil {
			return err
		}
		u.dataDir = defaultDir
	}
	sharedDir := defaultDir
	if _, portable := datadir.Portable(); portable {
		sharedDir = ""
	}
	level := ""
	if !u.production {
		level = "debug"
	}
	l, err := logs.Open(logs.Options{
		Path:   filepath.Join(u.dataDir, datadir.LogsDir, "rcui.log"),
		Stderr: !u.production,
		Level:  level,
	})
	if err != nil {
		return fmt.Errorf("could not open the log: %w", err)
	}
	u.logs = l
	// The app speaks the system's language until the core has read the language setting
	// (core/settings), which is before any window opens but after the first dialogs can show.
	u.applied.language = i18n.SetLanguage("")
	// The APIs read the log and the data folder at once, so they are created once both are known,
	// before the services that bind them.
	u.apis = core.NewAPIs(core.APIOptions{Emit: u.emitToCaller, Log: l, DataDir: u.dataDir})
	keepCrashes(filepath.Dir(l.Path()))
	// A panic that was recovered is logged with its stack. Each such line is also sent as a
	// crash report, when the user shares them.
	slog.SetDefault(slog.New(telemetry.TapPanics(l.Handler(), u.apis.Panic)))
	u.log = logs.Logger(logs.CompUI, "")
	u.log.Info("starting", "version", version.App, "os", runtime.GOOS, "arch", runtime.GOARCH, "production", u.production)

	exe, err := platform.Executable()
	if err != nil {
		return err
	}
	u.exe = exe
	// The agents' server stays stopped until the settings turn it on (loadSettings).
	u.agents = agents.New(agents.Options{
		APIs: u.apis, Log: logs.Logger(logs.CompUI, "agents"), DataDir: u.dataDir, Version: version.App,
		OpenWindow: func(route string) error { return u.windows.Open(route) },
		Changed:    func(st agents.Status) { u.app.Event.Emit(EventAgentsChanged, st) },
	})
	u.notifier = newNotifier(u.log, func(route string) {
		if err := u.windows.Open(route); err != nil {
			u.log.Error("could not open a toast's window", "route", route, "error", err)
		}
	})
	u.updates = &updateFlow{u: u, enabled: u.production || testFeed() != "", engine: update.Options{FeedURL: testFeed()}}

	u.app = application.New(application.Options{
		Name:        "Rclone UI",
		Description: i18n.T("Cross-platform GUI for rclone & S3"),
		Icon:        appIcon,
		Services:    u.services(),
		Assets: application.AssetOptions{
			Handler:        assets.Handler(),
			DisableLogging: true,
		},
		Mac: application.MacOptions{
			ActivationPolicy: application.ActivationPolicyAccessory,
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
			WebviewUserDataPath:           filepath.Join(u.dataDir, "webview"),
			// WebView2 flags. Pages render at a fixed scale, and windows are sized to match.
			AdditionalBrowserArgs: []string{"--ignore-gpu-blocklist", "--force-device-scale-factor=1"},
			DisabledFeatures:      []string{"msWebOOUI"},
			WndProcInterceptor:    u.wndProc,
		},
		Linux: application.LinuxOptions{
			DisableQuitOnLastWindowClosed: true,
			ApplicationID:                 appID(),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:               uniqueID(u.dataDir, sharedDir),
			OnSecondInstanceLaunch: u.secondInstance,
		},
		Flags:                       u.flags(),
		ShouldQuit:                  u.shouldQuit,
		OnShutdown:                  u.onShutdown,
		DisableDefaultSignalHandler: true,
		Logger:                      u.log.With("src", "wails"),
		LogLevel:                    slog.LevelWarn,
		PanicHandler: func(p *application.PanicDetails) {
			u.log.Error("panic", "error", p.Error, "stack", p.StackTrace)
		},
		ErrorHandler:   u.wailsError,
		WarningHandler: func(msg string) { u.log.Warn("wails", "warning", msg) },
	})

	u.windows = windows.New(u.app, u.log, u.production)
	// Which windows are used, in the usage data that the user shares (core/telemetry).
	u.windows.Opened = u.apis.Screen
	u.store = corestate.New(corestate.APIReader(u.apis), u.log.With("src", "corestate"))
	u.launcher = host.New(host.Options{
		App:        u.app,
		Log:        u.log,
		Store:      u.store,
		APIs:       u.apis,
		Production: u.production,
		Open:       u.windows.Open,
		Reveal:     func(path string) error { return u.reveal(path, true) },
		OpenURL:    u.openURL,
		Notify:     u.notifier.send,
		Quit:       func() { u.quit(false) },
		Acks:       gnome.Acks{Has: u.acknowledged, Add: u.acknowledge},
	})
	u.tray = tray.New(u.app, tray.Actions{
		ShowLauncher: u.launcher.Show,
		Open:         func() { go u.trayOpen(context.Background()) },
		OpenWindow: func(url string) {
			if err := u.windows.Open(url); err != nil {
				u.log.Error("could not open a window", "route", url, "error", err)
			}
		},
		// Opening the browser can wait on a command, and a menu click must not block.
		GitHub: func() {
			go func() {
				if err := u.openURL(providers.GitHubURL); err != nil {
					u.log.Error("could not open a URL", "url", providers.GitHubURL, "error", err)
				}
			}()
		},
		Quit: func() { go u.quit(false) },
	}, platform.IsLinuxMint())
	u.store.Subscribe(u.showInTray)
	menus.Set(u.app)

	u.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go u.started()
	})
	u.app.Event.OnApplicationEvent(events.Common.ApplicationLaunchedWithUrl, func(e *application.ApplicationEvent) {
		if link := e.Context().URL(); link != "" {
			go u.openLink(link)
		}
	})
	// On macOS, opening the app again from Finder, Spotlight or Launchpad while it runs doesn't
	// start a second instance. It sends a reopen event instead. Show the launcher, as a second
	// launch does on other systems, because the menu bar icon may be hidden behind the notch.
	u.app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
		u.launcher.Show()
	})
	u.handleSignals()
	return nil
}

func (u *ui) started() {
	u.waitForScreens(5 * time.Second)
	if m := platform.FlatpakMissing(); m.Any() {
		u.flatpakGate(m)
		return
	}
	if err := u.launcher.Create(); err != nil {
		u.log.Error("could not create the launcher", "error", err)
	}
	// Use the default shortcut until the core's settings replace it (see loadSettings), so the
	// launcher can be reached even when the core never starts.
	if err := u.launcher.SetShortcut(launcher.DefaultShortcut); err != nil {
		u.log.Error("could not register the launcher shortcut", "error", err)
	}
	u.notifier.start()
	// Only a release build on the app's own data does this. A development build, or a copy that
	// runs on another data directory (for tests or a scratch run), must never take over the
	// installed app's login item or its rclone:// links. A portable copy runs on its own data
	// folder, so it registers itself for the links, as the README in its zip says.
	if u.production && u.opts.dataDir == "" {
		u.registerScheme()
		// An enabled rclone link is updated when the app has moved.
		if err := pathlink.Refresh(); err != nil {
			u.log.Warn("could not refresh the rclone link", "error", err)
		}
	}

	u.startCore()

	// Links wait until the screens are known. A link that arrived earlier is opened now, together
	// with the launch's own link. (macOS reports a launch link as an event, which can arrive
	// before this point.)
	if u.opts.link != "" {
		u.openLink(u.opts.link)
	}
	u.links.release(u.handleLink)
	if u.opts.hidden {
		u.noStartup.Store(true)
	}
	if u.opts.open != "" {
		u.noStartup.Store(true)
		if err := u.windows.Open(u.opts.open); err != nil {
			u.log.Error("could not open the window", "route", u.opts.open, "error", err)
		}
	}
	u.devEval()
}

// waitForScreens waits until Wails knows the screens. On macOS, Wails reads them in its own
// didFinishLaunching handler, which races with ApplicationStarted. Every window is placed on a
// screen, so no window can be created before the screens are known.
func (u *ui) waitForScreens(limit time.Duration) {
	deadline := time.Now().Add(limit)
	for len(u.app.Screen.GetAll()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if len(u.app.Screen.GetAll()) == 0 {
		u.log.Warn("no screens known yet; windows may fail to open")
	}
}

// flatpakGate runs when the Flatpak lacks a permission it needs: access to the host's files, to
// the autostart folder and, on GNOME, to GNOME Shell's extensions. It explains the problem,
// offers the command that grants them, and exits. A user who granted disk access before the app
// needed the rest has to run the command again.
func (u *ui) flatpakGate(m platform.Missing) {
	cmd := platform.FlatpakOverride()
	msg := i18n.T("You are running the flatpak version of Rclone UI, which is sandboxed.") + "\n\n" + flatpakNeeds(m) +
		"\n\n" + cmd + "\n\n" + i18n.T("Restart Rclone UI afterwards.")
	// i18n: The title of the dialog that asks for the Flatpak's permissions.
	title := i18n.T("Flatpak Permissions Required")
	// i18n: A button that copies the command that grants the Flatpak's permissions, then quits the app.
	if interaction.Ask(interaction.Warning, title, msg, i18n.T("Copy Command & Exit"), i18n.T("Exit")) {
		u.app.Clipboard.SetText(cmd)
	}
	u.exit()
}

// flatpakNeeds returns the part of flatpakGate's message that lists the missing permissions.
func flatpakNeeds(m platform.Missing) string {
	var needs []string
	if m.Disk {
		needs = append(needs, i18n.T("Disk access to manage your files"))
	}
	if m.Autostart {
		needs = append(needs, i18n.T("Access to your autostart folder, to start when you log in"))
	}
	if m.GNOME {
		needs = append(needs, i18n.T("Access to GNOME's extensions to place the Launcher"))
	}
	// i18n: Followed by a list of the permissions that the Flatpak needs.
	head := i18n.T("Rclone UI needs:")
	if !m.Disk {
		// i18n: Followed by a list of the permissions that the Flatpak needs, after an update that needs more.
		head = i18n.T("Rclone UI now also needs:")
	}
	// i18n: Followed by the command. "It" or "them" are the permissions listed above.
	grant := i18n.N("Please grant it with this command, in your terminal:",
		"Please grant them with this command, in your terminal:", len(needs))
	return head + "\n\n• " + strings.Join(needs, "\n• ") + "\n\n" + grant
}

// registerScheme registers this executable for rclone:// links where no installer does it.
func (u *ui) registerScheme() {
	if platform.IsFlatpak() {
		return
	}
	exe := u.exe
	switch runtime.GOOS {
	case "linux":
		exe = os.Getenv("APPIMAGE")
		if exe == "" {
			return // deb and rpm declare the scheme in their .desktop file
		}
	case "darwin":
		return
	}
	if err := deeplink.Register(exe); err != nil {
		u.log.Warn("could not register rclone:// links", "error", err)
	}
}

// coreDown clears what the core was running, because it stopped along with the core. The store
// forgets it for both the tray and the launcher, so no dead mount is listed as active and no stop
// button stays enabled.
func (u *ui) coreDown() {
	u.store.CoreDown()
}

// showStartup opens the startup window once, when the core is first ready or when it failed. It
// does nothing if a deep link, --hidden or the "Show Startup screen" setting (see loadSettings)
// turned it off.
func (u *ui) showStartup() {
	if u.noStartup.Load() || u.quitting.Load() {
		return
	}
	u.startupOnce.Do(func() {
		if err := u.windows.Open("/startup"); err != nil {
			u.log.Error("could not open the startup window", "error", err)
			return
		}
		// On Linux the window shows only once. "Show Startup screen" is turned off after the
		// first time.
		if runtime.GOOS == "linux" {
			go u.hideStartupFromNow(context.Background())
		}
	})
}

// openLink handles a deep link once the boot knows the screens (see started). A link that arrives
// earlier waits until then.
func (u *ui) openLink(raw string) { u.links.add(raw, u.handleLink) }

// handleLink opens a deep link's window. It returns true once the window is open.
func (u *ui) handleLink(raw string) bool {
	link, ok := deeplink.Parse(raw)
	if !ok {
		u.log.Warn("ignored an unknown link", "link", raw)
		return false
	}
	if up := link.Update; up != nil {
		u.log.Info("update link", "version", up.Version, "channel", up.Channel)
		go u.updates.requested(context.Background(), UpdateRequest{Version: up.Version, Channel: up.Channel})
		return true
	}
	u.log.Info("deep link", "route", link.URL)
	if err := u.windows.Open(link.URL); err != nil {
		u.log.Error("could not open the link's window", "error", err)
		return false
	}
	// A link at start replaces the startup window. If the link's window failed to open, the
	// startup window still shows.
	u.noStartup.Store(true)
	return true
}

// links holds the deep links on their way to handleLink. They wait until release is called,
// because no window can open before the screens are known. Windows and Linux report a launch link
// both as an argument and as an event, so a link seen twice within a few seconds is handled
// once. The few seconds count from when its window opened, so a link whose window failed is
// tried again when it is reported again.
type links struct {
	mu      sync.Mutex // held while a link is handled, so two reports of the same link don't race
	open    bool
	pending []string
	last    string
	lastAt  time.Time
}

func (l *links) add(raw string, handle func(string) bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.open {
		l.pending = append(l.pending, raw)
		return
	}
	l.handle(raw, handle)
}

// release handles the waiting links in order, and makes every later link be handled right away.
func (l *links) release(handle func(string) bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.open = true
	pending := l.pending
	l.pending = nil
	for _, raw := range pending {
		l.handle(raw, handle)
	}
}

func (l *links) handle(raw string, handle func(string) bool) {
	if raw == l.last && time.Since(l.lastAt) < 5*time.Second {
		return
	}
	if handle(raw) {
		l.last, l.lastAt = raw, time.Now()
	}
}

func (u *ui) secondInstance(data application.SecondInstanceData) {
	if link := deeplink.FromArgs(data.Args); link != "" {
		u.openLink(link)
		return
	}
	// `rcui mcp` starts the app hidden when it finds none. When the app was running after all,
	// nothing should show.
	if slices.Contains(data.Args, "--hidden") {
		return
	}
	u.launcher.Show()
}

func (u *ui) hideWindows() {
	for _, w := range u.app.Window.GetAll() {
		w.Hide()
	}
}

// handleSignals makes SIGINT and SIGTERM quit through the quit flow, without asking. A second
// signal exits at once.
func (u *ui) handleSignals() {
	ch := make(chan os.Signal, 2)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-ch
		u.log.Info("signal received; quitting")
		go u.quit(true)
		<-ch
		os.Exit(1)
	}()
}

// flags returns the values that pages read synchronously (see lib/shell and Flags.GetFlag).
func (u *ui) flags() map[string]any {
	home, _ := os.UserHomeDir()
	return map[string]any{
		"version":         version.App,
		"production":      u.production,
		"homeDir":         home,
		"dataDir":         u.dataDir,
		"defaultShortcut": launcher.DefaultShortcut,
		// The app's language for this system, which a window starts in until it has read the
		// language setting (lib/i18n.ts).
		"systemLanguage": i18n.System(),
		"languages":      i18n.Languages(),
	}
}

// linuxEnvironment works around an NVIDIA bug. With some drivers, explicit sync breaks WebKitGTK
// on X11.
func linuxEnvironment() {
	if runtime.GOOS != "linux" {
		return
	}
	_, dri := os.Stat("/dev/dri")
	if dri == nil && os.Getenv("WAYLAND_DISPLAY") == "" && os.Getenv("XDG_SESSION_TYPE") == "x11" &&
		os.Getenv("__NV_DISABLE_EXPLICIT_SYNC") == "" {
		_ = os.Setenv("__NV_DISABLE_EXPLICIT_SYNC", "1")
	}
}
