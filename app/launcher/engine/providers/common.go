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

func All(c *Completion) []engine.Provider {
	return []engine.Provider{Operations{}, Running{}, Remotes{}, Navigation{}, Paths{}, c, Clipboard{}}
}

func Drops(c *Completion) []engine.Provider {
	return []engine.Provider{c, Dropped{}}
}

func open(id, name, route string, icon icons.Name, params ...string) engine.Action {
	return engine.Action{ID: id, Name: openName(name), Icon: icon, Opens: true, Run: func(_ context.Context, env engine.Env) error {
		env.OpenWindow(name, withParams(route, params...))
		return nil
	}}
}

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

func browse(p string) engine.Action {
	// i18n: An action that shows a folder's files in the Commander.
	return engine.Action{ID: "browse", Name: i18n.T("Browse"), Icon: icons.Folder, Opens: true, Run: func(_ context.Context, env engine.Env) error {
		env.OpenFull("Commander", withParams("/commander", "path", p))
		return nil
	}}
}

func copyText(id, name, text string) engine.Action {
	return engine.Action{ID: id, Name: name, Icon: icons.Clipboard, Run: func(_ context.Context, env engine.Env) error {
		env.Clipboard(text)
		// i18n: The title of the notification that something was copied to the clipboard.
		env.Notify(i18n.T("Copied"), text)
		return nil
	}}
}

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

func only(q engine.Query, words ...string) bool {
	return len(q.Paths) == 0 && q.URL == "" && len(q.Terms) == 1 &&
		slices.ContainsFunc(words, func(w string) bool { return strings.EqualFold(q.Terms[0], w) })
}

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

func inGroup(g string, rs []engine.Result) []engine.Result {
	for i := range rs {
		if rs[i].Group == "" {
			rs[i].Group = g
		}
	}
	return rs
}

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

func historyKey(kind, name string) string {
	return kind + ":" + name
}

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

func pathArg(p engine.Path) string { return p.Text }

func scoreFor(p engine.Path, remote, local int) int {
	if p.Local {
		return local
	}
	return remote
}
