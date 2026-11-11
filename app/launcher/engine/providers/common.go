// Package providers holds the launcher's providers, one file per domain: the operations, what is
// running (mounts, serves, VFS caches), the remotes, typed paths and their folders, and the app's
// own screens. The windows they open and the query parameters they pass are the ones that the
// pages read.
package providers

import (
	"context"
	"net/url"
	"slices"
	"strings"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/core/i18n"
)

// All returns every provider that a typed query uses, in the order used to break ties. c lists
// folders.
func All(c *Completion) []engine.Provider {
	return []engine.Provider{Operations{}, Running{}, Remotes{}, Navigation{}, Paths{}, c, Clipboard{}}
}

// Drops returns the providers used while files are dropped on the launcher. They offer places
// where the files can go.
func Drops(c *Completion) []engine.Provider {
	return []engine.Provider{c, Dropped{}}
}

// open returns an action that opens window name at route with params (empty ones are left out).
func open(id, name, route string, icon icons.Name, params ...string) engine.Action {
	return engine.Action{ID: id, Name: openName(name), Icon: icon, Opens: true, Run: func(_ context.Context, env engine.Env) error {
		env.OpenWindow(name, withParams(route, params...))
		return nil
	}}
}

// openName returns the name of the action that opens a window, such as "Open Settings", in the
// app's language. Each window has a message of its own, so that a language can say it its way.
func openName(window string) string {
	switch window {
	case "Wizard":
		return i18n.T("Open Wizard")
	case "Copy":
		return i18n.T("Open Copy")
	case "Move":
		return i18n.T("Open Move")
	case "Sync":
		return i18n.T("Open Sync")
	case "Bisync":
		return i18n.T("Open Bisync")
	case "Delete":
		return i18n.T("Open Delete")
	case "Purge":
		return i18n.T("Open Purge")
	case "Download":
		return i18n.T("Open Download")
	case "Mount":
		return i18n.T("Open Mount")
	case "Serve":
		return i18n.T("Open Serve")
	case "Settings":
		return i18n.T("Open Settings")
	case "Notifications":
		return i18n.T("Open Notifications")
	case "MobileRemoteControl":
		return i18n.T("Open Remote Control")
	case "History":
		return i18n.T("Open History")
	case "Templates":
		return i18n.T("Open Templates")
	case "Watchers":
		return i18n.T("Open Watchers")
	case "Schedules":
		return i18n.T("Open Schedules")
	case "Guides":
		return i18n.T("Open Guides")
	case "Automounts":
		return i18n.T("Open Automounts")
	}
	// i18n: An action that opens a window. %s is the window's name, for a window that has no message of its own.
	return i18n.T("Open %s", window)
}

// withParams returns route with the key/value pairs as its query, leaving out empty values. A key
// given more than once is repeated (for several sources).
func withParams(route string, kv ...string) string {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		if kv[i+1] != "" {
			v.Add(kv[i], kv[i+1])
		}
	}
	if s := v.Encode(); s != "" {
		return route + "?" + s
	}
	return route
}

// browse returns an action that opens the Commander at p (a full path, which may be a remote's
// root).
func browse(p string) engine.Action {
	// i18n: An action that shows a folder's files in the Commander.
	return engine.Action{ID: "browse", Name: i18n.T("Browse"), Icon: icons.Folder, Opens: true, Run: func(_ context.Context, env engine.Env) error {
		env.OpenFull("Commander", withParams("/commander", "path", p))
		return nil
	}}
}

// copyText returns an action that copies text to the clipboard and shows a notification. name is
// the action's name, in the app's language.
func copyText(id, name, text string) engine.Action {
	return engine.Action{ID: id, Name: name, Icon: icons.Clipboard, Run: func(_ context.Context, env engine.Env) error {
		env.Clipboard(text)
		// i18n: The title of the notification that something was copied to the clipboard.
		env.Notify(i18n.T("Copied"), text)
		return nil
	}}
}

// asks reports whether a typed word (of two letters or more) is the start of one of words, in
// the app's language or in English. For example, "br" asks for browse. Results that a word asks
// for ("Browse gdrive" for each remote) are offered only then, because otherwise they would crowd
// out the rows they repeat.
func asks(q engine.Query, words i18n.Text) bool {
	local, english := engine.Words(words)
	all := slices.Concat(local, english)
	for _, t := range q.Terms {
		if len([]rune(t)) < 2 {
			continue
		}
		for _, w := range all {
			if strings.HasPrefix(strings.ToLower(w), strings.ToLower(t)) {
				return true
			}
		}
	}
	return false
}

// only reports whether the query is one of words alone, as a drill-in leaves it ("vfs ").
func only(q engine.Query, words ...string) bool {
	return len(q.Paths) == 0 && q.URL == "" && len(q.Terms) == 1 &&
		slices.ContainsFunc(words, func(w string) bool { return strings.EqualFold(q.Terms[0], w) })
}

// command returns the first of words, which is a command typed in the query box ("browse"), in
// the app's language and in English. A drill-in types it in the app's language.
func command(words i18n.Text) (local, english string) {
	l, e := engine.Words(words)
	if len(l) > 0 {
		local = l[0]
	}
	if len(e) > 0 {
		english = e[0]
	}
	return local, english
}

// inGroup puts the results in rs that have no group yet into group g.
func inGroup(g string, rs []engine.Result) []engine.Result {
	for i := range rs {
		if rs[i].Group == "" {
			rs[i].Group = g
		}
	}
	return rs
}

// back returns the last row of a drill-in, which goes back to the empty query with the launcher
// still up. It isn't matched against the query and isn't kept in the history.
func back() engine.Result {
	// i18n: The launcher's row that goes back from a list to the first one.
	name := i18n.T("Back")
	return engine.Result{ID: "nav:back", Title: name, Subtitle: i18n.T("Return to the menu."), Icon: icons.Back, Score: 1, Always: true,
		Actions: []engine.Action{{ID: "back", Name: name, Icon: icons.Back, KeepOpen: true,
			Run: func(_ context.Context, env engine.Env) error {
				env.SetQuery("")
				return nil
			}}}}
}

// historyKey returns the history key for an item from the core ("remote:gdrive").
func historyKey(kind, name string) string {
	return kind + ":" + name
}

// pathKey returns the history key of a path. A folder has the same key with or without its
// trailing separator, whether it was typed (Browse) or completed.
func pathKey(p string) string {
	if n := len(p); n > 1 && (p[n-1] == '/' || p[n-1] == '\\') {
		p = p[:n-1]
	}
	return historyKey("path", p)
}

func countLabel(n int) string {
	// i18n: The grey count at the right of a launcher's row: how many of its items are running.
	return i18n.N("%d active", "%d active", n, n)
}

// pathArg returns a path in the form that an operation's page expects.
func pathArg(p engine.Path) string { return p.Text }

// scoreFor returns the score for a path's result, so remote paths can rank above local ones.
func scoreFor(p engine.Path, remote, local int) int {
	if p.Local {
		return local
	}
	return remote
}
