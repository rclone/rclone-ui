package providers

import (
	"context"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/app/launcher/match"
	"github.com/rclone/rclone-ui/core/i18n"
)

// Remotes offers the remotes (Browse, with the other actions in the ⌘K panel), editing a remote,
// and the remotes list and new remote screens in the Remotes window.
type Remotes struct{}

// The words that list every remote as a command: "browse" (a drill-in), "edit" and "automount".
// Each is a message of words separated by commas, which a translation gives in its language.
var (
	// i18n: Words that, typed in the launcher, list every remote to browse, separated by commas. The first one is the command itself.
	browseWords = i18n.M("browse, explore, open, view, files")
	// i18n: Words that, typed in the launcher, list every remote to edit, separated by commas.
	editWords = i18n.M("edit, change, update")
	// i18n: Words that, typed in the launcher, list every remote to mount when Rclone UI starts, separated by commas.
	autoMountWords = i18n.M("auto, automount, startup")
)

var (
	// i18n: Search words for the launcher's Show Remotes row, separated by commas. Add any word that people would type to find it.
	listWords = i18n.M("remotes, list, show, config")
	// i18n: Search words for the launcher's New Remote row, separated by commas. Add any word that people would type to find it.
	newWords = i18n.M("new, remote, create, add")
)

// Query lists the remotes that a word matches (or, for an empty query, the ones used often), and
// the remotes' settings.
func (Remotes) Query(_ context.Context, q engine.Query, d *engine.Data) []engine.Result {
	return inGroup(engine.GroupRemotes, remotes(q, d))
}

func remotes(q engine.Query, d *engine.Data) []engine.Result {
	out := []engine.Result{
		engine.Result{ID: "remote:list", Key: "remote:list", Subtitle: i18n.T("Show all configured remotes."),
			Icon: icons.Remotes, Score: 32, Actions: []engine.Action{remotesWindow("open", i18n.T("Open Remotes"), "", "")},
		}.Say(i18n.M("Show Remotes"), listWords),
		engine.Result{ID: "remote:new", Key: "remote:new", Subtitle: i18n.T("Create a new remote."),
			Icon: icons.NewRemote, Score: 28, Actions: []engine.Action{remotesWindow("open", i18n.T("Open Remotes"), "create", "")},
		}.Say(i18n.M("New Remote"), newWords),
	}
	if len(q.Paths) > 0 {
		// A remote typed as a path gets its settings here. Other providers offer the operations.
		seen := map[string]bool{}
		for _, p := range q.Paths {
			if p.Local || seen[p.Remote] {
				continue
			}
			seen[p.Remote] = true
			out = append(out, editResult(p.Remote, d), autoMountResult(p.Remote, d))
		}
		return out
	}
	browsing := asks(q, browseWords)
	for _, r := range d.Remotes {
		res := remoteResult(r, d)
		if browsing {
			// For browse, each remote is shown as "Browse gdrive" instead of its usual row, which
			// the browse words find with its name: "explore gd".
			res.Score = 140
			res = res.Say(i18n.M("Browse %s", r.Name), i18n.Text{})
			local, english := engine.Words(browseWords)
			for _, w := range local[min(1, len(local)):] {
				res.Keywords = append(res.Keywords, w+" "+r.Name)
			}
			for _, w := range english[1:] {
				res.English = append(res.English, w+" "+r.Name)
			}
		}
		out = append(out, res)
		if asks(q, editWords) {
			out = append(out, editResult(r.Name, d))
		}
		if asks(q, autoMountWords) {
			out = append(out, autoMountResult(r.Name, d))
		}
	}
	if browsing && len(d.Remotes) == 0 {
		out = append(out, engine.Result{ID: "remote:browse", Key: "remote:browse",
			Subtitle: i18n.T("Add a remote to browse its files."), Icon: icons.Folder, Score: 37,
			Actions: []engine.Action{remotesWindow("new", i18n.T("New Remote"), "create", "")},
		}.Say(i18n.M("Browse"), browseWords))
	}
	if local, english := command(browseWords); only(q, local, english) {
		out = append(out, back())
	}
	// A remote's name typed after a command ("copy gdr"): Tab completes it to the remote's root.
	if w := q.TypingWord; w != "" && len(q.Terms) > 1 {
		for _, r := range d.Remotes {
			m, ok := match.Match(w, r.Name)
			if !ok {
				continue
			}
			c := engine.Result{
				ID: "remote:complete:" + r.Name, Key: historyKey("remote", r.Name), Title: r.Name + ":",
				// i18n: %s is a remote's root, such as "gdrive:". Tab puts it in the search box.
				Subtitle: i18n.T("Complete to %s", r.Name+":"), Icon: icons.Remote, Score: 90 + m.Score, Always: true,
				Complete: r.Name + ":", Actions: []engine.Action{browse(r.Name + ":")},
			}
			c.SetMatch(m.Positions)
			out = append(out, c)
		}
	}
	return out
}

// remoteResult returns a remote's result. Its default action browses it, and the ⌘K panel lists
// everything else that can start from its root.
func remoteResult(r engine.Remote, d *engine.Data) engine.Result {
	root := r.Name + ":"
	p := engine.Path{Text: root, Remote: r.Name, Features: r.Features}
	res := engine.Result{
		ID: "remote:" + r.Name, Key: historyKey("remote", r.Name), Title: r.Name, Subtitle: r.Type,
		Icon: icons.Remote, Keywords: []string{r.Type}, Score: 100,
		Actions: append(pathActions(p, d, true), copyText("copy-name", i18n.T("Copy Name"), root)), Complete: root,
	}
	// "browse gdrive" finds the remote, in the app's language and in English.
	local, english := command(browseWords)
	res.Keywords = append(res.Keywords, local+" "+r.Name)
	if english != local {
		res.English = append(res.English, english+" "+r.Name)
	}
	return res
}

func editResult(name string, d *engine.Data) engine.Result {
	// i18n: %s is a remote's name.
	title := i18n.M("Edit %s", name)
	// i18n: Search words for the launcher's row that edits a remote, separated by commas. Add any word that people would type to find it.
	words := i18n.M("edit, change, update, remote, settings")
	return engine.Result{ID: "remote:edit:" + name, Key: historyKey("edit", name),
		Subtitle: i18n.T("Edit a remote."), Icon: icons.Edit, Score: 140,
		// i18n: An action that opens a remote's settings, to change them.
		Actions: []engine.Action{remotesWindow("edit", i18n.T("Edit"), "edit", name)},
	}.Say(title, words)
}

func autoMountResult(name string, d *engine.Data) engine.Result {
	// i18n: %s is a remote's name. An automount mounts it each time Rclone UI starts.
	title := i18n.M("New automount for %s", name)
	// i18n: Search words for the launcher's row that adds an automount of a remote, separated by commas. Add any word that people would type to find it.
	words := i18n.M("mount, auto, automount, startup")
	return engine.Result{ID: "remote:automount:" + name, Key: historyKey("automount", name),
		Subtitle: i18n.T("Mount it each time Rclone UI starts."), Icon: icons.Automounts, Score: 140,
		Actions: []engine.Action{newAutomount(name + ":")},
	}.Say(title, words)
}

// newAutomount returns an action that opens the Automounts window with a new automount of source,
// a remote's root or a folder in it.
func newAutomount(source string) engine.Action {
	return engine.Action{ID: "automount", Name: i18n.T("New Automount"), Icon: icons.Automounts, Opens: true,
		Run: func(_ context.Context, env engine.Env) error {
			env.OpenWindow("Automounts", withParams("/automounts", "action", "create", "source", source))
			return nil
		}}
}

// remotesWindow returns an action that opens the Remotes window, with an action on a remote. name
// is the action's name, in the app's language.
func remotesWindow(id, name, action, remote string) engine.Action {
	return engine.Action{ID: id, Name: name, Icon: icons.Remotes, Opens: true, Run: func(_ context.Context, env engine.Env) error {
		env.OpenWindow("Remotes", withParams("/remotes", "action", action, "remote", remote))
		return nil
	}}
}
