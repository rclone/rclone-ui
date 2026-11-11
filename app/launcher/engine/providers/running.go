package providers

import (
	"context"
	"errors"
	"net"
	"slices"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/app/corestate"
	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/core"
	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/transfers"
)

// Running offers what the core is running: its transfers, mounts and serves, listed in the Active
// group (also on the empty query) with the actions for each, plus the transfers that failed in
// the last day and the VFS caches. The rows that stop them show when a word asks for them
// ("stop", "unmount") or when the history says they are used.
type Running struct{}

// activeMax is the maximum number of running items that the empty query lists. Any more are
// shown in a drill-in ("active ").
const activeMax = 4

// A failed transfer is listed for failedFor after it ended. The empty query lists only the
// failedMax newest ones.
const (
	failedFor = 24 * time.Hour
	failedMax = 3
)

// activeWords list every running item. The first is the drill-in that lists all of them.
var (
	// i18n: Words that, typed in the launcher, list everything that is running, separated by commas. The launcher types the first one itself, so it must be one word.
	activeWords = i18n.M("active, running")
)

func (Running) Query(_ context.Context, q engine.Query, d *engine.Data) []engine.Result {
	var out []engine.Result
	out = append(out, transferRunResults(q, d)...)
	out = append(out, mountResults(q, d)...)
	out = append(out, serveRunResults(q, d)...)
	if r, ok := StopEverything(d); ok && len(q.Paths) == 0 {
		out = append(out, r)
	}
	for i := range out {
		out[i].Group = engine.GroupActive
	}
	if q.Empty() {
		out = capActive(out)
	}
	out = append(out, failedResults(q, d, time.Now())...)
	if local, english := engine.Words(activeWords); only(q, slices.Concat(local, english)...) {
		out = append(out, back())
	}
	return append(out, vfsResults(q, d)...)
}

// watcherRun reports whether t is a watcher's own run. A watcher runs every minute and has its own
// window, so its runs are left out of the launcher's rows, as they are of the tray's. A retry
// from History is the user's own run, so it is shown, as the transfer service treats it.
func watcherRun(t transfers.Transfer) bool {
	return t.Origin.Kind == transfers.OriginWatcher && t.RetryOf == ""
}

// failedResults returns the transfers that failed in the last day, newest first. Each one opens
// its details in the History window: "Sync failed: Photos → gdrive:Photos".
func failedResults(q engine.Query, d *engine.Data, now time.Time) []engine.Result {
	var out []engine.Result
	for _, t := range d.Failed {
		if t.EndedAt == nil || watcherRun(t) {
			continue
		}
		ended := time.UnixMilli(*t.EndedAt)
		if now.Sub(ended) > failedFor {
			continue
		}
		if !reads(q, t.Destination) && !slices.ContainsFunc(t.Sources, func(s string) bool { return reads(q, s) }) {
			continue
		}
		if q.Empty() && len(out) == failedMax {
			break
		}
		what := operationName(t.Operation)
		// i18n: A failed transfer. %s is its operation, such as "Sync".
		name := i18n.M("%s failed", what)
		if paths := transferPaths(t); paths != "" {
			// i18n: A failed transfer. %[1]s is its operation, such as "Sync", and %[2]s its paths.
			name = i18n.M("%[1]s failed: %[2]s", what, paths)
		}
		// i18n: When a transfer failed. %s is how long ago, such as "10 min ago".
		sub := i18n.T("Failed %s.", ago(ended, now))
		if msg, _, _ := strings.Cut(strings.TrimSpace(t.Error), "\n"); msg != "" {
			// i18n: When a transfer failed, and why. %[1]s is how long ago, such as "10 min ago", and %[2]s the error.
			sub = i18n.T("Failed %[1]s: %[2]s", ago(ended, now), msg)
		}
		r := engine.Result{
			ID: "run:failed:" + t.ID, Subtitle: sub, Icon: icons.Failed,
			Keywords: []string{string(t.Operation)}, Score: 131, Group: engine.GroupActive,
			Actions: []engine.Action{open("open", "History", "/history", icons.Transfers, "id", t.ID)},
		}
		// i18n: Search words for the launcher's rows of failed transfers, separated by commas. Add any word that people would type to find them.
		out = append(out, r.Say(name, i18n.M("failed, error, history, transfers")))
	}
	return out
}

// capActive limits the empty query's running items to activeMax rows. When there are more, it
// keeps the first few and adds a row that shows all of them.
func capActive(rs []engine.Result) []engine.Result {
	n := 0
	for _, r := range rs {
		if !r.Recent {
			n++
		}
	}
	if n <= activeMax {
		return rs
	}
	var out []engine.Result
	kept := 0
	for _, r := range rs {
		if !r.Recent {
			if kept == activeMax-1 {
				continue
			}
			kept++
		}
		out = append(out, r)
	}
	more := n - kept
	return append(out, engine.Result{
		ID: "run:all", Title: i18n.T("Show All Running"), Subtitle: i18n.N("%d more running.", "%d more running.", more, more), Tail: countLabel(n),
		Icon: icons.Search, Score: 1, Group: engine.GroupActive,
		Actions: []engine.Action{{ID: "list", Name: i18n.T("Show All"), Icon: icons.Search, KeepOpen: true,
			Run: func(_ context.Context, env engine.Env) error {
				word, _ := command(activeWords)
				env.SetQuery(word + " ")
				return nil
			}}},
	})
}

// transferRunResults returns the queued and running transfers as one row that opens the History
// window, and a row that stops them, shown when asked for.
func transferRunResults(q engine.Query, d *engine.Data) []engine.Result {
	var ts []transfers.Transfer
	for _, t := range d.Transfers {
		if watcherRun(t) {
			continue
		}
		if reads(q, t.Destination) || slices.ContainsFunc(t.Sources, func(s string) bool { return reads(q, s) }) {
			ts = append(ts, t)
		}
	}
	if len(ts) == 0 {
		return nil
	}
	running := 0
	for _, t := range ts {
		if t.State == transfers.StateRunning {
			running++
		}
	}
	var live []*bus.TransferProgress
	for _, t := range ts {
		if t.State == transfers.StateRunning {
			live = append(live, t.Live)
		}
	}
	// their progress, once the core reports it: "42% · 12 MB/s · 3 min left"
	progress := progressLine(corestate.SumProgress(live))
	queued := len(ts) - running
	title := i18n.MN("%d Transfer", "%d Transfers", len(ts), len(ts))
	var subtitle string
	switch {
	case len(ts) == 1:
		title = transferTitle(ts[0])
		// i18n: The state of a transfer that waits for its turn.
		subtitle = i18n.T("Queued")
		if running == 1 {
			// i18n: The state of a transfer that runs.
			subtitle = i18n.T("Running")
		}
	case queued == 0:
		subtitle = i18n.N("%d running", "%d running", running, running)
	case running == 0:
		subtitle = i18n.N("%d queued", "%d queued", queued, queued)
	default:
		// i18n: How many transfers run, and how many wait for their turn.
		subtitle = i18n.T("%[1]d running, %[2]d queued", running, queued)
	}
	// The state is a label, with no period, so that a language's own punctuation isn't mixed
	// with ours.
	switch {
	case progress == "":
	case len(ts) == 1:
		subtitle = progress
	default:
		subtitle += " · " + progress
	}
	// i18n: Search words for the launcher's rows of the running transfers, separated by commas. Add any word that people would type to find them.
	words := i18n.M("transfers, history, jobs, stop, cancel")
	stop := stopTransfers(ts)
	return []engine.Result{
		engine.Result{
			ID: "run:transfers", Key: historyKey("transfers", "running"), Subtitle: subtitle,
			Icon: icons.Transfers, Score: 132,
			Actions: []engine.Action{open("open", "History", "/history", icons.Transfers), stop.Action},
		}.Say(title, words).Say(i18n.Text{}, activeWords),
		engine.Result{
			ID: "run:transfers:stop", Key: historyKey("stoptransfers", "running"), Subtitle: title.Local(),
			Icon: icons.Stop, Score: 125, Recent: true, Actions: []engine.Action{stop.Action},
		}.Say(stop.title, words),
	}
}

// transferTitle describes what a transfer does: "Copy gdrive:Photos → /Users/me/Photos".
func transferTitle(t transfers.Transfer) i18n.Text {
	paths := transferPaths(t)
	if paths == "" {
		return operationName(t.Operation)
	}
	if o, ok := opByID(string(t.Operation)); ok {
		return o.on(paths)
	}
	switch t.Operation {
	case operations.OperationSave:
		return i18n.M("Save %s", paths)
	case operations.OperationRename:
		return i18n.M("Rename %s", paths)
	case operations.OperationDeleteFolder:
		return i18n.M("Delete Folder %s", paths)
	case operations.OperationCleanup:
		return i18n.M("Clean up %s", paths)
	}
	// i18n: A transfer whose operation has no name. %s is its paths.
	return i18n.M("Transfer %s", paths)
}

// operationName names a transfer's operation: "Copy", "Delete Folder".
func operationName(o operations.Operation) i18n.Text {
	if op, ok := opByID(string(o)); ok {
		return op.name
	}
	switch o {
	case operations.OperationSave:
		// i18n: The operation that saves a file that was edited in the app.
		return i18n.M("Save")
	case operations.OperationRename:
		return i18n.M("Rename")
	case operations.OperationDeleteFolder:
		return i18n.M("Delete Folder")
	case operations.OperationCleanup:
		return i18n.M("Cleanup")
	}
	// i18n: A transfer whose operation has no name.
	return i18n.M("Transfer")
}

// transferPaths describes a transfer's paths: "gdrive:Photos → /Users/me/Photos", "gdrive:old".
func transferPaths(t transfers.Transfer) string {
	out := ""
	if s := t.Sources; len(s) > 0 {
		out = engine.Path{Text: s[0]}.Short()
		if more := len(s) - 1; more > 0 {
			// i18n: The sources of a transfer. %s is the first one's path.
			out = i18n.N("%s and %d more", "%s and %d more", more, out, more)
		}
	}
	if dst := t.Destination; dst != "" {
		out = strings.TrimSpace(out + " → " + engine.Path{Text: dst}.Short())
	}
	return out
}

// stopAction is an action that stops something, with the title of its row.
type stopAction struct {
	engine.Action
	title i18n.Text
}

// stopTransfers returns an action that stops the transfers ts, after asking for confirmation.
func stopTransfers(ts []transfers.Transfer) stopAction {
	n := len(ts)
	name, question := i18n.M("Stop All Transfers"), i18n.N("Stop %d transfer?", "Stop %d transfers?", n, n)
	if n == 1 {
		name = i18n.M("Stop Transfer")
		// i18n: %s is a transfer, such as "Copy gdrive:Photos → /Users/me/Photos".
		question = i18n.T("Stop %s?", transferTitle(ts[0]))
	}
	return stopAction{title: name, Action: engine.Action{ID: "stop", Name: name.Local(), Icon: icons.Stop, Stay: true, Confirm: question,
		Run: func(ctx context.Context, env engine.Env) error {
			c := env.Core().Transfers
			if c == nil {
				return errNoCore
			}
			working, done := i18n.T("Stopping a transfer…"), i18n.T("Stopped a transfer.")
			if n > 1 {
				working = i18n.N("Stopping %d transfer…", "Stopping %d transfers…", n, n)
				done = i18n.N("Stopped %d transfer.", "Stopped %d transfers.", n, n)
			}
			env.Status(engine.StatusWorking, working)
			var failed []error
			for _, t := range ts {
				if err := stopTransfer(ctx, c, t.ID); err != nil {
					failed = append(failed, err)
				}
			}
			if err := errors.Join(failed...); err != nil {
				return err
			}
			env.Status(engine.StatusDone, done)
			return nil
		}}}
}

// stopTransfer stops one transfer. A transfer that ended in the meantime counts as stopped.
func stopTransfer(ctx context.Context, c engine.Transfers, id string) error {
	err := c.Stop(ctx, id)
	if errors.Is(err, transfers.ErrNotRunning) {
		return nil
	}
	return err
}

// StopEverything returns the Stop Everything row. Its action stops every transfer (a watcher's or
// a schedule's run included), serve and mount that the core runs, and the remote tunnel. It first
// asks a question that names what is running according to d, with the same phrase as the quit
// dialog. It returns false when nothing is running. The launcher's stop button uses it too.
func StopEverything(d *engine.Data) (engine.Result, bool) {
	running := core.Running{Transfers: len(d.Transfers), Mounts: len(d.Mounts), Serves: len(d.Serves), Tunnel: d.Tunnel}
	if running == (core.Running{}) {
		return engine.Result{}, false
	}
	what := running.Phrase()
	// i18n: The launcher's row and action that stop everything that is running.
	title := i18n.M("Stop Everything")
	a := engine.Action{ID: "stop-everything", Name: title.Local(), Icon: icons.StopAll, Stay: true,
		// i18n: %s names what is running: "2 transfers, a serve and 3 mounts".
		Confirm: i18n.T("Stop %s?", what), Run: stopEverything}
	// i18n: Search words for the launcher's Stop Everything row, separated by commas. Add any word that people would type to find it.
	words := i18n.M("stop, everything, all, emergency, panic, kill")
	return engine.Result{
		// i18n: %s names what is running: "2 transfers, a serve and 3 mounts".
		ID: "run:everything", Key: "run:stop-everything", Subtitle: i18n.T("Stop %s.", what),
		Icon: icons.StopAll, Score: 118, Recent: true, Group: engine.GroupActive, Actions: []engine.Action{a},
	}.Say(title, words), true
}

// stopEverything asks the core to stop everything it runs. The core makes its own list of what is
// running, so what started after the question was asked stops too. The status then shows the
// core's summary of what stopped.
func stopEverything(ctx context.Context, env engine.Env) error {
	c := env.Core().Everything
	if c == nil {
		return errNoCore
	}
	env.Status(engine.StatusWorking, i18n.T("Stopping everything…"))
	sum, err := c.StopAll(ctx)
	if err != nil {
		return err
	}
	env.Status(engine.StatusDone, sum.Done().Local())
	return nil
}

// reads reports whether a running item that reads source matches one of the typed paths. When
// no path is typed, every item matches.
func reads(q engine.Query, source string) bool {
	if len(q.Paths) == 0 {
		return true
	}
	for _, p := range q.Paths {
		if strings.HasPrefix(source, strings.TrimSuffix(p.Text, "/")) {
			return true
		}
	}
	return false
}

var (
	// i18n: Search words for the launcher's rows of running mounts, separated by commas. Add any word that people would type to find them.
	mountWords = i18n.M("mount, mounted, unmount, stop, open")
	// i18n: Search words for the launcher's rows of running serves, separated by commas. Add any word that people would type to find them.
	serveWords = i18n.M("serve, serving, stop, address")
)

func mountResults(q engine.Query, d *engine.Data) []engine.Result {
	var out []engine.Result
	for _, m := range d.Mounts {
		if !reads(q, m.Source) {
			continue
		}
		// i18n: The state of a mount that is ready.
		state := i18n.T("Mounted")
		if m.State != string(children.StatusRunning) {
			// i18n: The state of a mount or a serve that is starting.
			state = i18n.T("Starting")
		}
		if m.Error != "" {
			state = m.Error
		}
		// i18n: An action that opens a mounted folder in the file manager.
		reveal := engine.Action{ID: "open", Name: i18n.T("Open"), Icon: icons.Open, Run: func(_ context.Context, env engine.Env) error {
			env.Reveal(m.MountPoint)
			return nil
		}}
		actions := []engine.Action{
			reveal, stopMount(m),
			copyText("copy-point", i18n.T("Copy Mount Point"), m.MountPoint),
			copyText("copy-source", i18n.T("Copy Source"), m.Source), browse(m.Source),
		}
		// i18n: %s is the folder or drive that a remote is mounted at.
		unmount := i18n.M("Unmount %s", m.MountPoint)
		out = append(out, engine.Result{
			ID: "run:mount:" + m.ID, Key: historyKey("mount", m.Source+" "+m.MountPoint),
			Title: m.Source + " → " + m.MountPoint, Subtitle: state, Icon: icons.Mount, Score: 130, Actions: actions,
		}.Say(i18n.Text{}, mountWords).Say(i18n.Text{}, activeWords), engine.Result{
			// the Stop row makes the stop available without the ⌘K panel
			ID: "run:mount:stop:" + m.ID, Key: historyKey("unmount", m.Source+" "+m.MountPoint),
			Subtitle: m.Source, Icon: icons.Stop, Score: 125, Recent: true, Actions: []engine.Action{stopMount(m)},
		}.Say(unmount, mountWords))
	}
	if n := len(d.Mounts); n > 1 && len(q.Paths) == 0 {
		title := i18n.M("Unmount All")
		// i18n: Search words for the launcher's Unmount All row, separated by commas. Add any word that people would type to find it.
		words := i18n.M("unmount, stop, mounts, all")
		out = append(out, engine.Result{
			ID: "run:mount:all", Key: "mount:stop-all", Icon: icons.Stop, Tail: countLabel(n), Score: 120, Recent: true,
			Actions: []engine.Action{{ID: "stop-all", Name: title.Local(), Icon: icons.Stop, Stay: true,
				Confirm: i18n.N("Unmount all %d mounts?", "Unmount all %d mounts?", n, n),
				Run: func(ctx context.Context, env engine.Env) error {
					c := env.Core().Mounts
					if c == nil {
						return errNoCore
					}
					env.Status(engine.StatusWorking, i18n.T("Unmounting everything…"))
					err := c.StopAll(ctx)
					if err == nil {
						env.Status(engine.StatusDone, i18n.T("Every mount is stopped."))
					}
					return err
				}}},
		}.Say(title, words))
	}
	return out
}

func stopMount(m mounts.MountRow) engine.Action {
	// i18n: The action that stops a mount.
	return engine.Action{ID: "stop", Name: i18n.T("Unmount"), Icon: icons.Stop, Stay: true,
		// i18n: %s is the folder or drive that a remote is mounted at.
		Confirm: i18n.T("Unmount %s?", m.MountPoint),
		Run: func(ctx context.Context, env engine.Env) error {
			c := env.Core().Mounts
			if c == nil {
				return errNoCore
			}
			env.Status(engine.StatusWorking, i18n.T("Unmounting %s…", m.MountPoint))
			err := c.Stop(ctx, m.ID)
			if err == nil {
				env.Status(engine.StatusDone, i18n.T("Unmounted %s.", m.MountPoint))
			}
			return err
		}}
}

func serveRunResults(q engine.Query, d *engine.Data) []engine.Result {
	var out []engine.Result
	for _, v := range d.Serves {
		if !reads(q, v.Source) {
			continue
		}
		// i18n: The state of a serve that is ready.
		state := i18n.T("Serving")
		if v.State != string(children.StatusRunning) {
			state = i18n.T("Starting")
		}
		if v.Error != "" {
			state = v.Error
		}
		actions := []engine.Action{copyAddress(v), stopServe(v)}
		if t := strings.ToLower(v.Type); t == "http" || t == "webdav" {
			u := serveURL(v.Addr)
			actions = append(actions, engine.Action{ID: "browser", Name: i18n.T("Open in Browser"), Icon: icons.Browser,
				Run: func(_ context.Context, env engine.Env) error {
					env.OpenURL(u)
					return nil
				}})
		}
		typ := strings.ToLower(v.Type)
		// i18n: %s is a serve: its protocol and what it serves, such as "HTTP gdrive:".
		stop := i18n.M("Stop %s", strings.ToUpper(v.Type)+" "+v.Source)
		out = append(out, engine.Result{
			ID: "run:serve:" + v.ID, Key: historyKey("serve", v.Type+" "+v.Source),
			Title: strings.ToUpper(v.Type) + " " + v.Source + " · " + v.Addr, Subtitle: state,
			Icon: icons.Serve, Keywords: []string{typ}, Score: 129, Actions: actions,
		}.Say(i18n.Text{}, serveWords).Say(i18n.Text{}, activeWords), engine.Result{
			ID: "run:serve:stop:" + v.ID, Key: historyKey("stopserve", v.Type+" "+v.Source),
			Subtitle: v.Addr, Icon: icons.Stop, Keywords: []string{typ}, Score: 125, Recent: true,
			Actions: []engine.Action{stopServe(v)},
		}.Say(stop, serveWords))
	}
	if n := len(d.Serves); n > 1 && len(q.Paths) == 0 {
		title := i18n.M("Stop All Serves")
		// i18n: Search words for the launcher's Stop All Serves row, separated by commas. Add any word that people would type to find it.
		words := i18n.M("stop, serves, all")
		out = append(out, engine.Result{
			ID: "run:serve:all", Key: "serve:stop-all", Icon: icons.Stop, Tail: countLabel(n), Score: 120, Recent: true,
			Actions: []engine.Action{{ID: "stop-all", Name: title.Local(), Icon: icons.Stop, Stay: true,
				Confirm: i18n.N("Stop all %d serves?", "Stop all %d serves?", n, n),
				Run: func(ctx context.Context, env engine.Env) error {
					c := env.Core().Serves
					if c == nil {
						return errNoCore
					}
					env.Status(engine.StatusWorking, i18n.T("Stopping every serve…"))
					err := c.StopAll(ctx)
					if err == nil {
						env.Status(engine.StatusDone, i18n.T("Every serve is stopped."))
					}
					return err
				}}},
		}.Say(title, words))
	}
	return out
}

// copyAddress returns an action that copies the serve's address to the clipboard, as the Serve
// page does.
func copyAddress(v serves.ServeRow) engine.Action {
	return engine.Action{ID: "copy", Name: i18n.T("Copy Address"), Icon: icons.Clipboard, Run: func(_ context.Context, env engine.Env) error {
		env.Clipboard(v.Addr)
		env.Notify(i18n.T("Address Copied"), i18n.T("%s copied to clipboard", v.Addr))
		return nil
	}}
}

func stopServe(v serves.ServeRow) engine.Action {
	// i18n: The action that stops a serve.
	return engine.Action{ID: "stop", Name: i18n.T("Stop"), Icon: icons.Stop, Stay: true,
		// i18n: %[1]s is what is served, such as "gdrive:", and %[2]s its protocol, such as HTTP.
		Confirm: i18n.T("Stop serving %[1]s over %[2]s?", v.Source, strings.ToUpper(v.Type)),
		Run: func(ctx context.Context, env engine.Env) error {
			c := env.Core().Serves
			if c == nil {
				return errNoCore
			}
			// i18n: %s is the address that a serve listens at, such as 127.0.0.1:8080.
			env.Status(engine.StatusWorking, i18n.T("Stopping the serve at %s…", v.Addr))
			err := c.Stop(ctx, v.ID)
			if err == nil {
				env.Status(engine.StatusDone, i18n.T("Stopped the serve at %s.", v.Addr))
			}
			return err
		}}
}

// serveURL returns a serve's address in a form this machine's browser can open. A serve that
// listens on every interface is reached at 127.0.0.1.
func serveURL(addr string) string {
	if strings.Contains(addr, "://") {
		return addr
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://" + addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

var (
	// i18n: Search words for the launcher's VFS cache rows, separated by commas. VFS is rclone's virtual file system. Add any word that people would type to find them.
	vfsWords = i18n.M("vfs, cache, forget")
)

func vfsResults(q engine.Query, d *engine.Data) []engine.Result {
	var out []engine.Result
	for _, v := range d.Vfs {
		if !reads(q, v.Fs) {
			continue
		}
		// i18n: %s is the remote whose cache it is, such as "gdrive:".
		title := i18n.M("Forget the VFS cache of %s", v.Fs)
		out = append(out, engine.Result{
			ID: "run:vfs:" + v.ID, Key: historyKey("vfs", v.Fs),
			Subtitle: vfsOwner(v.Kind) + " · " + v.Name, Icon: icons.VFS, Score: 130, Recent: true,
			Actions: []engine.Action{forget(v.ID, v.Fs)},
		}.Say(title, vfsWords))
	}
	if n := len(d.Vfs); n > 1 && len(q.Paths) == 0 {
		out = append(out, engine.Result{
			ID: "run:vfs:all", Key: "vfs:forget-all", Icon: icons.VFS, Tail: countLabel(n), Score: 120, Recent: true,
			Actions: []engine.Action{forget("", "")},
		}.Say(i18n.M("Forget Every VFS Cache"), vfsWords))
	}
	// The VFS item leads to the caches on an empty query. When no cache is in use, it shows for a
	// typed word too, to say so. VFS is rclone's name, so its title isn't translated.
	vfs := engine.Result{ID: "run:vfs", Key: "vfs", Title: "VFS", Subtitle: i18n.T("Forget the local cache for one or all remotes."),
		Icon: icons.VFS, Score: 35}.Say(i18n.Text{}, vfsWords)
	if len(d.Vfs) == 0 {
		vfs.Subtitle = i18n.T("No VFS cache in use.")
	} else {
		vfs.Tail = countLabel(len(d.Vfs))
		vfs.Actions = []engine.Action{{ID: "list", Name: i18n.T("Show Caches"), Icon: icons.VFS, KeepOpen: true,
			Run: func(_ context.Context, env engine.Env) error {
				env.SetQuery("vfs ")
				return nil
			}}}
	}
	if len(q.Paths) == 0 && (q.Empty() || len(d.Vfs) == 0) {
		out = append(out, vfs)
	}
	for i := range out {
		out[i].Group = engine.GroupOperations
	}
	if only(q, "vfs") {
		out = append(out, back())
	}
	return out
}

// vfsOwner names what uses a VFS cache: a mount or a serve.
func vfsOwner(kind string) string {
	switch kind {
	case "mount":
		// i18n: What uses a VFS cache, shown in lower case before its name: "mount · /Volumes/gdrive".
		return i18n.T("mount")
	case "serve":
		// i18n: What uses a VFS cache, shown in lower case before its name: "serve · http 127.0.0.1:8080".
		return i18n.T("serve")
	}
	return kind
}

// forget returns an action that forgets the VFS cache with id, of the remote fs. An empty id
// forgets every cache.
func forget(id, fs string) engine.Action {
	working, done := i18n.T("Forgetting every VFS cache…"), i18n.T("Forgot every VFS cache.")
	if id != "" {
		// i18n: %s is the remote whose cache it is, such as "gdrive:".
		working, done = i18n.T("Forgetting the VFS cache of %s…", fs), i18n.T("Forgot the VFS cache of %s.", fs)
	}
	// i18n: The action that clears a VFS cache.
	return engine.Action{ID: "forget", Name: i18n.T("Forget"), Icon: icons.VFS, Stay: true, Run: func(ctx context.Context, env engine.Env) error {
		c := env.Core().Vfs
		if c == nil {
			return errNoCore
		}
		env.Status(engine.StatusWorking, working)
		if err := c.Forget(ctx, id); err != nil {
			return err
		}
		env.Status(engine.StatusDone, done)
		return nil
	}}
}
