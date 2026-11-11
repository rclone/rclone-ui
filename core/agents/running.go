package agents

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/serves"
)

// A mount and a serve run as processes of their own, so they are few, and their lists have no
// limit.

func (s *Server) runningTools() {
	s.listMountsTool()
	s.mountTool()
	s.unmountTool()
	s.listServesTool()
	s.serveTool()
	s.stopServeTool()
	s.openWindowTool()
}

// optionLeftOut is an option that a tool didn't use, with the reason, so that the agent learns
// which options an operation takes.
type optionLeftOut struct {
	Option string `json:"option"`
	Reason string `json:"reason"`
}

// optionGroupsFor sorts an agent's flat options into the groups of op's form, as the options of a
// template are sorted (operations.TemplateGroups). serve is a serve's protocol, or "" for any
// other operation. It returns the options that the form leaves out, with the reason. The values
// are checked when the operation starts.
func optionGroupsFor(op operations.Operation, serve string, flat map[string]any) (operations.Groups, []optionLeftOut, error) {
	if len(flat) == 0 {
		return operations.Groups{}, nil, nil
	}
	raw := make(catalog.Group, len(flat))
	for key, v := range flat {
		b, err := json.Marshal(v)
		if err != nil {
			return operations.Groups{}, nil, err
		}
		raw[key] = b
	}
	groups, skipped, err := operations.TemplateGroups(op, serve, raw)
	if err != nil {
		return operations.Groups{}, nil, err
	}
	var left []optionLeftOut
	for _, sk := range skipped {
		left = append(left, optionLeftOut{Option: sk.Flag, Reason: sk.Reason})
	}
	return groups, left, nil
}

type mountItem struct {
	ID         string `json:"id" jsonschema:"the mount's id, for unmount"`
	Source     string `json:"source"`
	MountPoint string `json:"mount_point" jsonschema:"the folder, or on Windows the drive, where the source's files appear"`
	State      string `json:"state" jsonschema:"starting, running (ready to use) or restarting (it went down and is starting again)"`
	// UploadsWaiting counts the files written through the mount that aren't on the remote yet.
	UploadsWaiting int    `json:"uploads_waiting"`
	Error          string `json:"error,omitempty" jsonschema:"why it last went down, while it restarts"`
	NeedsRestart   bool   `json:"needs_restart,omitempty" jsonschema:"a remote it mounts changed since it started: unmount it and mount it again for the change to apply"`
	// IgnoredOptions are the options that mount didn't use. Only mount returns them.
	IgnoredOptions []optionLeftOut `json:"ignored_options,omitempty"`
}

func mountItemOf(r mounts.MountRow) mountItem {
	return mountItem{
		ID: r.ID, Source: r.Source, MountPoint: r.MountPoint, State: r.State,
		UploadsWaiting: r.UploadsPending, Error: r.Error, NeedsRestart: r.Restart,
	}
}

type mountList struct {
	Mounts []mountItem `json:"mounts"`
}

func (s *Server) listMountsTool() {
	add(s, &mcp.Tool{
		Name: "list_mounts",
		Description: "The remotes that are mounted now as folders or drives on this computer: each mount's id, source, mount point, " +
			"state, the uploads still waiting to reach the remote, and its error while it restarts.",
		Annotations: reads("List mounts"),
	}, func(ctx context.Context, _ nothing) (mountList, error) {
		rows, err := s.o.APIs.Mounts.List(ctx, true)
		if err != nil {
			return mountList{}, err
		}
		out := mountList{Mounts: make([]mountItem, 0, len(rows))}
		for _, r := range rows {
			out.Mounts = append(out.Mounts, mountItemOf(r))
		}
		return out, nil
	})
}

type mountIn struct {
	Source     string         `json:"source" jsonschema:"what to mount: a folder of a remote, such as gdrive:Photos, or gdrive: for its root"`
	MountPoint string         `json:"mount_point,omitempty" jsonschema:"where its files appear: an empty folder, or one that doesn't exist yet, such as /Users/me/Rclone/gdrive; on Windows a free drive letter such as M: or * for the next free one. Leave it out for ~/Rclone/<remote>, or the next free drive on Windows."`
	Options    map[string]any `json:"options,omitempty" jsonschema:"rclone's mount, vfs, filter and config options by name, such as {\"vfs_cache_mode\": \"full\", \"read_only\": true}"`
}

// suggestedMountPoint returns where the Mount window mounts source when the user doesn't choose
// (src/pages/Mount/mountPoint.ts): a folder named after its remote in ~/Rclone, which the core
// creates, or on Windows the next free drive letter. A folder on this computer has no suggestion.
func suggestedMountPoint(source string) (string, error) {
	if runtime.GOOS == "windows" {
		return "*", nil
	}
	if err := location.Refusal(source); err != nil {
		return "", err
	}
	at, err := location.Split(source)
	if err != nil {
		return "", err
	}
	name := strings.TrimPrefix(at.Name, ":") // an on-the-fly remote such as :s3 is named after its type
	if at.Local || name == "local" || name == "" {
		return "", errs.New("Give a mount_point to mount a folder of this computer: an empty folder, or one that doesn't exist yet.")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errs.New("This computer's home folder can't be found, so give a mount_point.")
	}
	return filepath.Join(home, "Rclone", name), nil
}

func (s *Server) mountTool() {
	add(s, &mcp.Tool{
		Name: "mount",
		Description: "Mounts a remote's folder as a folder (or on Windows a drive) of this computer, so that every app can open its files. " +
			"It returns once the mount is ready, with its id and mount point. The mount keeps running until unmount, or until the app quits. " +
			"Without a mount_point, it mounts at ~/Rclone/<remote> (the next free drive on Windows), as the app's Mount window does. " +
			"Options it doesn't use come back in ignored_options. The about tool says whether this computer can mount.",
		Annotations: changes("Mount a remote"),
	}, func(ctx context.Context, in mountIn) (mountItem, error) {
		sup, err := s.o.APIs.Mounts.Support(ctx)
		if err != nil {
			return mountItem{}, err
		}
		if !sup.Supported {
			fix := "The user has to set this up before anything can be mounted."
			if sup.CanInstall {
				fix = "The user can install WinFsp from the app's Mount window."
			} else if sup.Docs != "" {
				fix = "See " + sup.Docs + "."
			}
			return mountItem{}, errs.Errorf("This computer can't mount: %s %s", sup.Reason, fix)
		}
		point := in.MountPoint
		if point == "" {
			if point, err = suggestedMountPoint(in.Source); err != nil {
				return mountItem{}, err
			}
		}
		groups, left, err := optionGroupsFor(operations.OperationMount, "", in.Options)
		if err != nil {
			return mountItem{}, err
		}
		row, err := s.o.APIs.Mounts.StartReady(ctx, operations.MountArgs{Source: in.Source, Destination: point, Options: groups})
		if err != nil {
			return mountItem{}, err
		}
		out := mountItemOf(row)
		out.IgnoredOptions = left
		return out, nil
	})
}

type mountIDIn struct {
	MountID string `json:"mount_id" jsonschema:"the mount's id, from list_mounts or mount"`
}

type unmounted struct {
	Unmounted string `json:"unmounted" jsonschema:"the mount point that was unmounted"`
}

func (s *Server) unmountTool() {
	add(s, &mcp.Tool{
		Name: "unmount",
		Description: "Unmounts a mount. Apps that have its files open lose them. Uploads that haven't reached the remote yet are kept, " +
			"and are sent the next time the same folder is mounted at the same place. It returns once the mount is gone.",
		Annotations: destroys("Unmount"),
	}, func(ctx context.Context, in mountIDIn) (unmounted, error) {
		rows, err := s.o.APIs.Mounts.List(ctx, false)
		if err != nil {
			return unmounted{}, err
		}
		point := ""
		for _, r := range rows {
			if r.ID == in.MountID {
				point = r.MountPoint
			}
		}
		if err := s.o.APIs.Mounts.Stop(ctx, in.MountID); err != nil {
			return unmounted{}, err
		}
		return unmounted{Unmounted: point}, nil
	})
}

type serveItem struct {
	ID       string `json:"id" jsonschema:"the serve's id, for stop_serve"`
	Source   string `json:"source"`
	Protocol string `json:"protocol"`
	Address  string `json:"address" jsonschema:"host:port where clients connect"`
	State    string `json:"state" jsonschema:"starting, running (it accepts connections) or restarting (it went down and is starting again)"`
	Error    string `json:"error,omitempty" jsonschema:"why it last went down, while it restarts"`
	// NeedsRestart is true when a remote it serves changed after it started.
	NeedsRestart bool `json:"needs_restart,omitempty" jsonschema:"a remote it serves changed since it started: stop it and serve it again for the change to apply"`
	// Warning and IgnoredOptions are only in what serve returns.
	Warning        string          `json:"warning,omitempty"`
	IgnoredOptions []optionLeftOut `json:"ignored_options,omitempty"`
}

// serveItemOf converts a serve's row. Its form isn't returned, because it holds the serve's
// password.
func serveItemOf(r serves.ServeRow) serveItem {
	return serveItem{
		ID: r.ID, Source: r.Source, Protocol: r.Type, Address: r.Addr, State: r.State,
		Error: r.Error, NeedsRestart: r.Restart,
	}
}

type serveList struct {
	Serves []serveItem `json:"serves"`
}

func (s *Server) listServesTool() {
	add(s, &mcp.Tool{
		Name: "list_serves",
		Description: "The folders that this computer shares now on the network (serves): each one's id, source, protocol, " +
			"the address where clients connect, its state, and its error while it restarts.",
		Annotations: reads("List serves"),
	}, func(ctx context.Context, _ nothing) (serveList, error) {
		rows, err := s.o.APIs.Serves.List(ctx)
		if err != nil {
			return serveList{}, err
		}
		out := serveList{Serves: make([]serveItem, 0, len(rows))}
		for _, r := range rows {
			out.Serves = append(out.Serves, serveItemOf(r))
		}
		return out, nil
	})
}

// serveLogins says, for each protocol, which options make a client sign in. dlna and nfs have
// none. An sftp serve refuses to start without one, unless no_auth is set.
var serveLogins = map[string]string{
	"http":   "user and pass (or htpasswd, a file of users)",
	"webdav": "user and pass (or htpasswd, a file of users)",
	"restic": "user and pass (or htpasswd, a file of users)",
	"ftp":    "user and pass",
	"sftp":   "user and pass (or authorized_keys, a file of SSH keys)",
	"s3":     `auth_key, as "ACCESS_KEY_ID,SECRET_ACCESS_KEY"`,
}

// loginOptions are the options that make a client of a serve sign in, by rclone's name.
var loginOptions = []string{"user", "pass", "htpasswd", "auth_key", "authorized_keys", "auth_proxy"}

// openWarning returns the warning for a serve that anyone who reaches it can use, or "" for one
// that asks clients to sign in.
func openWarning(protocol, addr string, serve catalog.Group) string {
	given := func(name string) bool {
		for key, raw := range serve {
			if catalog.NormalizeOptionName(key) == name {
				var v any
				return json.Unmarshal(raw, &v) == nil && v != nil && v != "" && v != false
			}
		}
		return false
	}
	reach := "anyone who can reach " + addr
	if host, _, err := net.SplitHostPort(addr); err == nil {
		if ip := net.ParseIP(host); host == "localhost" || (ip != nil && ip.IsLoopback()) {
			reach = "any program on this computer"
		}
	}
	can := "read and change the files (unless read_only is set)"
	if protocol == "http" || protocol == "dlna" { // they only read
		can = "read the files"
	}
	logins, ok := serveLogins[protocol]
	switch {
	case !ok:
		return protocol + " has no sign-in, so " + reach + " can " + can + "."
	case protocol == "sftp":
		if given("no_auth") {
			return "no_auth is set, so " + reach + " can " + can + "."
		}
		return ""
	case slices.ContainsFunc(loginOptions, given):
		return ""
	}
	return "No user and password are set, so " + reach + " can " + can + ". " +
		"To require a sign-in, stop this serve and serve again with " + logins + " in options."
}

type serveIn struct {
	Source   string         `json:"source" jsonschema:"the folder to share: a remote path such as gdrive:Shared, or a folder of this computer such as /Users/me/Public"`
	Protocol string         `json:"protocol" jsonschema:"http (browse and download in a web browser), webdav (open as a network drive), ftp, sftp, s3, dlna (media players and TVs), nfs or restic (a backup repository)"`
	Address  string         `json:"address,omitempty" jsonschema:"host:port to listen on: 127.0.0.1:8080 for this computer only, :8080 for the whole network, and port 0 for any free port. Leave it out for rclone's default for the protocol."`
	Options  map[string]any `json:"options,omitempty" jsonschema:"rclone's options for the serve and its vfs, filter and config by name, such as {\"user\": \"me\", \"pass\": \"secret\", \"read_only\": true}"`
}

func (s *Server) serveTool() {
	add(s, &mcp.Tool{
		Name: "serve",
		Description: "Shares a folder on the network over http, webdav, ftp, sftp, s3, dlna, nfs or restic, until stop_serve or until the app quits. " +
			"It returns once the serve accepts connections, with the address to connect to. " +
			"Without a sign-in, anyone who can reach the address can read the files: set the options user and pass " +
			"(http, webdav, restic, ftp, sftp), or auth_key as \"ACCESS_KEY_ID,SECRET_ACCESS_KEY\" (s3). dlna and nfs have no sign-in. " +
			"warning says when the serve is open to anyone. A protocol that this computer lacks is refused with the list of those it has. " +
			"Options it doesn't use come back in ignored_options.",
		Annotations: changes("Serve a folder"),
	}, func(ctx context.Context, in serveIn) (serveItem, error) {
		protocol := strings.ToLower(strings.TrimSpace(in.Protocol))
		if types := s.o.APIs.Serves.Types(); !slices.Contains(types, protocol) {
			return serveItem{}, errs.Errorf("This computer can't serve over %q. Use one of: %s.", in.Protocol, strings.Join(types, ", "))
		}
		groups, left, err := optionGroupsFor(operations.OperationServe, protocol, in.Options)
		if err != nil {
			return serveItem{}, err
		}
		row, err := s.o.APIs.Serves.StartReady(ctx, operations.ServeArgs{Type: protocol, Source: in.Source, Addr: in.Address, Options: groups})
		if err != nil {
			return serveItem{}, err
		}
		out := serveItemOf(row)
		out.Warning = openWarning(protocol, row.Addr, groups.Serve)
		out.IgnoredOptions = left
		return out, nil
	})
}

type serveIDIn struct {
	ServeID string `json:"serve_id" jsonschema:"the serve's id, from list_serves or serve"`
}

type stopped struct {
	Stopped string `json:"stopped" jsonschema:"the address that no longer answers"`
}

func (s *Server) stopServeTool() {
	add(s, &mcp.Tool{
		Name:        "stop_serve",
		Description: "Stops a serve. Its clients are disconnected, and its address no longer answers. It returns once the serve is gone.",
		Annotations: destroys("Stop a serve"),
	}, func(ctx context.Context, in serveIDIn) (stopped, error) {
		rows, err := s.o.APIs.Serves.List(ctx)
		if err != nil {
			return stopped{}, err
		}
		addr := ""
		for _, r := range rows {
			if r.ID == in.ServeID {
				addr = r.Addr
			}
		}
		if err := s.o.APIs.Serves.Stop(ctx, in.ServeID); err != nil {
			return stopped{}, err
		}
		return stopped{Stopped: addr}, nil
	})
}

// appWindows are the app's windows that open_window shows, by the names of their routes
// (src/routes.ts). The startup screen, the launcher's window and the dev pages are left out.
var appWindows = []string{
	"remotes", "commander", "history", "schedules", "watchers", "templates", "automounts",
	"copy", "move", "sync", "bisync", "delete", "purge", "download", "mount", "serve",
	"settings", "notifications", "mobileRemoteControl", "guides", "wizard",
}

// The windows that take a path to start with, as the launcher opens them
// (app/launcher/engine/providers): a source as initialSource, and a destination (a mount's mount
// point) as initialDestination. The Commander takes a folder to show as path.
var (
	windowsWithSource      = []string{"copy", "move", "sync", "bisync", "delete", "purge", "mount", "serve", "commander"}
	windowsWithDestination = []string{"copy", "move", "sync", "bisync", "download", "mount"}
)

type openWindowIn struct {
	Window      string `json:"window" jsonschema:"the window to show: remotes, commander (a file manager), history (the transfers), schedules, watchers, templates, automounts, copy, move, sync, bisync, delete, purge, download, mount, serve, settings, notifications, mobileRemoteControl (to use the app from a phone), guides or wizard"`
	TransferID  string `json:"transfer_id,omitempty" jsonschema:"for history: the transfer to show, by its id"`
	Source      string `json:"source,omitempty" jsonschema:"for copy, move, sync, bisync, delete, purge, mount and serve: the path to fill in as the source, such as gdrive:Photos; for commander: the folder to show"`
	Destination string `json:"destination,omitempty" jsonschema:"for copy, move, sync, bisync and download: the destination to fill in; for mount: the mount point"`
}

type windowOpened struct {
	Opened string `json:"opened" jsonschema:"the window that the user now sees"`
}

func (s *Server) openWindowTool() {
	add(s, &mcp.Tool{
		Name: "open_window",
		Description: "Shows the user one of the app's windows, to point them at something: History on a transfer, " +
			"or an operation's window with its paths filled in for them to check and start. The window opens in front, " +
			"and nothing starts by itself. Use it when the user asks to see something, or when a step is theirs to take.",
		Annotations: changes("Open a window"),
	}, func(_ context.Context, in openWindowIn) (windowOpened, error) {
		// The name is matched without case, and spelled as the route spells it from here on.
		asked := strings.TrimSpace(in.Window)
		i := slices.IndexFunc(appWindows, func(w string) bool { return strings.EqualFold(w, asked) })
		if i < 0 {
			return windowOpened{}, errs.Errorf("The app has no %q window. Use one of: %s.", in.Window, strings.Join(appWindows, ", "))
		}
		window := appWindows[i]
		query := url.Values{}
		if in.TransferID != "" {
			if window != "history" {
				return windowOpened{}, errs.New("Only the history window takes a transfer_id.")
			}
			query.Set("id", in.TransferID)
		}
		if in.Source != "" {
			if !slices.Contains(windowsWithSource, window) {
				return windowOpened{}, errs.Errorf("The %s window takes no source.", window)
			}
			if window == "commander" {
				query.Set("path", in.Source)
			} else {
				query.Set("initialSource", in.Source)
			}
		}
		if in.Destination != "" {
			if !slices.Contains(windowsWithDestination, window) {
				return windowOpened{}, errs.Errorf("The %s window takes no destination.", window)
			}
			query.Set("initialDestination", in.Destination)
		}
		if s.o.OpenWindow == nil {
			return windowOpened{}, errs.New("This app can't show windows.")
		}
		route := "/" + window
		if len(query) > 0 {
			route += "?" + query.Encode()
		}
		if err := s.o.OpenWindow(route); err != nil {
			return windowOpened{}, err
		}
		return windowOpened{Opened: window}, nil
	})
}
