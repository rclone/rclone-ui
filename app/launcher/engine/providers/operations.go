package providers

import (
	"context"
	"net/url"
	"path"
	"strings"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/core/i18n"
)

// Operations offers the operation pages (copy, move, sync, bisync, delete, purge, download, mount,
// serve), opened with the typed paths, and cleanup, which runs in the launcher. The empty query
// lists none of them: "Run" opens the Wizard, which asks what the user wants to do and
// finds the operation for it. Typing finds each operation by name.
type Operations struct{}

// wizard returns "Run", which opens the Wizard.
func wizard() engine.Result {
	return engine.Result{
		ID: "op:wizard", Key: "op:wizard", Icon: icons.Wizard, Score: 50,
		Subtitle: i18n.T("Copy, Sync, Move, Bisync, and other rclone operations."),
		Actions:  []engine.Action{open("open", "Wizard", "/wizard", icons.Wizard)},
	}.Say(
		// i18n: The launcher's row that opens the Wizard, which asks what to do and finds the operation for it.
		i18n.M("Run"),
		// i18n: Search words for the launcher's Run row, separated by commas. Add any word that people would type to find it.
		i18n.M("wizard, run, operation, start, new"))
}

// op is an operation page. Its messages name it in its rows.
type op struct {
	id, window, route string
	icon              icons.Name
	name, desc        i18n.Text
	// words are the search words, separated by commas (see engine.Result.Say).
	words i18n.Text
	// on names the operation on a path, or on a transfer's paths: "Copy gdrive:Photos".
	on    func(what string) i18n.Text
	score int // ranks the operations that a query matches equally
	// pair, from and to are set for an operation from a source to a destination. pair names it
	// on both ("Copy gdrive:a → /b"), from on its source and to on its destination.
	pair     func(src, dst string) i18n.Text
	from, to func(p string) i18n.Text
}

var (
	copyOp = op{id: "copy", window: "Copy", route: "/copy", icon: icons.Copy, score: 50,
		// i18n: The Copy operation, which copies files from a source to a destination.
		name: i18n.M("Copy"),
		desc: i18n.M("Copy files from a source to a destination without deleting destination files."),
		// i18n: Search words for the launcher's Copy row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("copy, cp"),
		on:    func(w string) i18n.Text { return i18n.M("Copy %s", w) },
		pair:  func(a, b string) i18n.Text { return i18n.M("Copy %s → %s", a, b) },
		from:  func(p string) i18n.Text { return i18n.M("Copy from %s", p) },
		to:    func(p string) i18n.Text { return i18n.M("Copy to %s", p) }}
	moveOp = op{id: "move", window: "Move", route: "/move", icon: icons.Move, score: 48,
		name: i18n.M("Move"),
		desc: i18n.M("Move files from a source to a destination and delete them from the source."),
		// i18n: Search words for the launcher's Move row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("move, mv"),
		on:    func(w string) i18n.Text { return i18n.M("Move %s", w) },
		pair:  func(a, b string) i18n.Text { return i18n.M("Move %s → %s", a, b) },
		from:  func(p string) i18n.Text { return i18n.M("Move from %s", p) },
		to:    func(p string) i18n.Text { return i18n.M("Move to %s", p) }}
	syncOp = op{id: "sync", window: "Sync", route: "/sync", icon: icons.Sync, score: 46,
		name: i18n.M("Sync"),
		desc: i18n.M("Make destination match source (deletes extra files)."),
		// i18n: Search words for the launcher's Sync row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("sync, synchronise, synchronize"),
		on:    func(w string) i18n.Text { return i18n.M("Sync %s", w) },
		pair:  func(a, b string) i18n.Text { return i18n.M("Sync %s → %s", a, b) },
		from:  func(p string) i18n.Text { return i18n.M("Sync from %s", p) },
		to:    func(p string) i18n.Text { return i18n.M("Sync to %s", p) }}
	bisyncOp = op{id: "bisync", window: "Bisync", route: "/bisync", icon: icons.Bisync, score: 44,
		name: i18n.M("Bisync"),
		desc: i18n.M("Keeps two folders the same, in both directions."),
		// i18n: Search words for the launcher's Bisync row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("bisync, two-way"),
		on:    func(w string) i18n.Text { return i18n.M("Bisync %s", w) },
		pair:  func(a, b string) i18n.Text { return i18n.M("Bisync %s ↔ %s", a, b) },
		from:  func(p string) i18n.Text { return i18n.M("Bisync from %s", p) },
		to:    func(p string) i18n.Text { return i18n.M("Bisync to %s", p) }}
	deleteOp = op{id: "delete", window: "Delete", route: "/delete", icon: icons.Delete, score: 38,
		name: i18n.M("Delete"),
		desc: i18n.M("Delete files or folders from a remote or local path."),
		// i18n: Search words for the launcher's Delete row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("delete, remove, rm"),
		on:    func(w string) i18n.Text { return i18n.M("Delete %s", w) }}
	purgeOp = op{id: "purge", window: "Purge", route: "/purge", icon: icons.Purge, score: 36,
		name: i18n.M("Purge"),
		desc: i18n.M("Purge an entire path from a remote, deleting everything."),
		// i18n: Search words for the launcher's Purge row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("purge, empty"),
		on:    func(w string) i18n.Text { return i18n.M("Purge %s", w) }}
	downloadOp = op{id: "download", window: "Download", route: "/download", icon: icons.Download, score: 45,
		name: i18n.M("Download"),
		desc: i18n.M("Download a URL directly into a remote or local path."),
		// i18n: Search words for the launcher's Download row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("download, url, copyurl, copyto"),
		on:    func(w string) i18n.Text { return i18n.M("Download %s", w) }}
	mountOp = op{id: "mount", window: "Mount", route: "/mount", icon: icons.Mount, score: 42,
		// i18n: The Mount operation, which mounts a remote as a local folder or drive.
		name: i18n.M("Mount"),
		desc: i18n.M("Mount a remote to the local filesystem with VFS options."),
		// i18n: Search words for the launcher's Mount row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("mount"),
		on:    func(w string) i18n.Text { return i18n.M("Mount %s", w) }}
	serveOp = op{id: "serve", window: "Serve", route: "/serve", icon: icons.Serve, score: 40,
		// i18n: The Serve operation, which serves a remote over HTTP, WebDAV, SFTP and more.
		name: i18n.M("Serve"),
		desc: i18n.M("Serve a remote over HTTP, WebDAV, SFTP, FTP and Restic."),
		// i18n: Search words for the launcher's Serve row, separated by commas. Add any word that people would type to find it.
		words: i18n.M("serve, http, webdav, sftp, ftp, restic, dlna, nfs, s3"),
		on:    func(w string) i18n.Text { return i18n.M("Serve %s", w) }}
)

// opByID returns the operation page with that id. A transfer's Operation uses the same ids.
func opByID(id string) (op, bool) {
	for _, o := range []op{copyOp, moveOp, syncOp, bisyncOp, deleteOp, purgeOp, downloadOp, mountOp, serveOp} {
		if o.id == id {
			return o, true
		}
	}
	return op{}, false
}

// pairOps are the operations from a source to a destination.
var pairOps = []op{copyOp, moveOp, syncOp, bisyncOp}

// from returns an action that opens o's window with p as its source. name is its label in the ⌘K
// panel.
func from(o op, p engine.Path, name string) engine.Action {
	return named(open(o.id, o.window, o.route, o.icon, "initialSource", pathArg(p)), name)
}

// Query returns the operations. Without paths or a URL, it also returns "Run". With paths, it
// offers each operation on them (as a pair for two or more). With a URL, it offers to download it.
func (Operations) Query(_ context.Context, q engine.Query, d *engine.Data) []engine.Result {
	var out []engine.Result
	if len(q.Paths) == 0 && q.URL == "" {
		out = append(out, wizard())
	}
	for _, o := range pairOps {
		out = append(out, transferResults(o, q)...)
	}
	out = append(out, singleResults(deleteOp, q, func(engine.Path) bool { return true })...)
	out = append(out, singleResults(purgeOp, q, func(p engine.Path) bool { return p.Can("Purge") })...)
	out = append(out, singleResults(mountOp, q, func(engine.Path) bool { return true })...)
	out = append(out, serveResults(q, d)...)
	out = append(out, downloadResults(q)...)
	out = append(out, cleanupResults(q, d)...)
	return inGroup(engine.GroupOperations, out)
}

// generic returns an operation's own result, which opens its window empty. The empty query gets
// none: "Run" stands for them there.
func generic(o op, q engine.Query) []engine.Result {
	if q.Empty() {
		return nil
	}
	return []engine.Result{o.result(engine.Result{
		ID: "op:" + o.id, Key: "op:" + o.id, Score: o.score,
		Actions: []engine.Action{open("open", o.window, o.route, o.icon)},
	}, o.name)}
}

// result returns r as one of o's rows: titled title, with o's description, icon and search words.
func (o op) result(r engine.Result, title i18n.Text) engine.Result {
	r.Subtitle, r.Icon = o.desc.Local(), o.icon
	return r.Say(title, o.words)
}

func transferResults(o op, q engine.Query) []engine.Result {
	if len(q.Paths) == 0 {
		return generic(o, q)
	}
	var out []engine.Result
	if len(q.Paths) >= 2 {
		src, dst := q.Paths[0], q.Paths[len(q.Paths)-1]
		out = append(out, o.result(engine.Result{
			ID: "op:" + o.id + ":pair", Key: "op:" + o.id, Score: 200,
			Actions: []engine.Action{open("open", o.window, o.route, o.icon, "initialSource", pathArg(src), "initialDestination", pathArg(dst))},
		}, o.pair(src.Short(), dst.Short())))
	}
	for i, p := range q.Paths {
		role, label, score := "initialSource", o.from(p.Short()), scoreFor(p, 160, 140)
		if len(q.Paths) >= 2 && i == len(q.Paths)-1 {
			role, label, score = "initialDestination", o.to(p.Short()), 155
		}
		out = append(out, o.result(engine.Result{
			ID: "op:" + o.id + ":" + role + ":" + p.Text, Key: "op:" + o.id, Score: score,
			Actions: []engine.Action{open("open", o.window, o.route, o.icon, role, pathArg(p))},
		}, label))
	}
	return out
}

// singleResults returns an operation on one path at a time, for the paths that ok accepts.
func singleResults(o op, q engine.Query, ok func(engine.Path) bool) []engine.Result {
	if len(q.Paths) == 0 {
		return generic(o, q)
	}
	var out []engine.Result
	for _, p := range q.Paths {
		if !ok(p) {
			continue
		}
		out = append(out, o.result(engine.Result{
			ID: "op:" + o.id + ":" + p.Text, Key: "op:" + o.id, Score: scoreFor(p, 150, 140),
			Actions: []engine.Action{open("open", o.window, o.route, o.icon, "initialSource", pathArg(p))},
		}, o.on(p.Short())))
	}
	return out
}

// serveResults returns Serve for each path, over the type named by a word ("serve webdav
// gdrive:").
func serveResults(q engine.Query, d *engine.Data) []engine.Result {
	typ := ""
	for _, t := range q.Terms {
		for _, st := range d.ServeTypes {
			if strings.EqualFold(t, st) {
				typ = st
			}
		}
	}
	if len(q.Paths) == 0 {
		return generic(serveOp, q)
	}
	var out []engine.Result
	for _, p := range q.Paths {
		label := serveOp.on(p.Short())
		if typ != "" {
			// i18n: %[1]s is a path, and %[2]s a protocol such as WEBDAV.
			label = i18n.M("Serve %[1]s over %[2]s", p.Short(), strings.ToUpper(typ))
		}
		out = append(out, serveOp.result(engine.Result{
			ID: "op:serve:" + typ + ":" + p.Text, Key: "op:serve", Score: scoreFor(p, 160, 140),
			Actions: []engine.Action{open("open", "Serve", "/serve", icons.Serve, "initialSource", pathArg(p), "initialType", typ)},
		}, label))
	}
	return out
}

// downloadResults returns downloads of the typed URL into each typed path. Either can be left
// out and chosen later in the window.
func downloadResults(q engine.Query) []engine.Result {
	if q.URL == "" && len(q.Paths) == 0 {
		return generic(downloadOp, q)
	}
	label := urlLabel(q.URL)
	var out []engine.Result
	for _, p := range q.Paths {
		t, score := i18n.M("Download to %s", p.Short()), scoreFor(p, 160, 150)
		if q.URL != "" {
			// i18n: %[1]s is the file that a link points to, and %[2]s where it goes.
			t, score = i18n.M("Download %[1]s to %[2]s", label, p.Short()), scoreFor(p, 200, 190)
		}
		out = append(out, downloadOp.result(engine.Result{
			ID: "op:download:" + p.Text, Key: "op:download", Score: score, Always: q.URL != "",
			Actions: []engine.Action{open("open", "Download", "/download", icons.Download, "initialUrl", q.URL, "initialDestination", pathArg(p))},
		}, t))
	}
	if q.URL != "" && len(q.Paths) == 0 {
		r := downloadOp.result(engine.Result{
			ID: "op:download:url", Key: "op:download", Score: 170, Always: true,
			Actions: []engine.Action{open("open", "Download", "/download", icons.Download, "initialUrl", q.URL)},
		}, downloadOp.on(label))
		r.Subtitle = q.URL
		out = append(out, r)
	}
	return out
}

// urlLabel returns the last name in a URL's path, or its host.
func urlLabel(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if base := path.Base(u.Path); base != "" && base != "/" && base != "." {
		return base
	}
	return u.Host
}

// cleanupResults returns Cleanup for each remote that supports it: the typed ones, or all of them
// when a word is typed. If none supports it, a typed word gets a Cleanup row that says so. No row
// has a history key, because a single pick would move Cleanup above Browse for the typed remote,
// and Enter would then ask to delete.
func cleanupResults(q engine.Query, d *engine.Data) []engine.Result {
	desc := i18n.T("Clean up a remote: empty its trash, or delete old versions of files.")
	// i18n: Search words for the launcher's Cleanup rows, separated by commas. Add any word that people would type to find them.
	words := i18n.M("cleanup, clean, trash")
	var remotes []string
	if len(q.Paths) > 0 {
		seen := map[string]bool{}
		for _, p := range q.Paths {
			if p.Can("CleanUp") && !seen[p.Remote] {
				seen[p.Remote] = true
				remotes = append(remotes, p.Remote)
			}
		}
	} else if len(q.Terms) > 0 {
		for _, r := range d.Remotes {
			if r.Features["CleanUp"] {
				remotes = append(remotes, r.Name)
			}
		}
	}
	var out []engine.Result
	for _, r := range remotes {
		// i18n: %s is a remote's name.
		title := i18n.M("Clean up %s", r)
		out = append(out, engine.Result{
			ID: "op:cleanup:" + r, Subtitle: desc, Icon: icons.Cleanup, Score: 150, Actions: []engine.Action{cleanup(r)},
		}.Say(title, words))
	}
	if len(remotes) == 0 && len(q.Paths) == 0 && len(q.Terms) > 0 {
		// i18n: The cleanup operation, which empties a remote's trash and removes old file versions.
		title := i18n.M("Cleanup")
		out = append(out, engine.Result{
			ID: "op:cleanup", Subtitle: i18n.T("None of the remotes here can be cleaned up."), Icon: icons.Cleanup, Score: 36,
		}.Say(title, words))
	}
	return out
}

// cleanup returns an action that starts rclone's cleanup of remote as a transfer, so the History
// page can follow it. It asks for confirmation first, because what it deletes can't be recovered.
func cleanup(remote string) engine.Action {
	return engine.Action{ID: "cleanup", Name: i18n.T("Cleanup"), Icon: icons.Cleanup, Stay: true,
		Confirm: i18n.T("Clean up %s? Trash and old file versions will be removed for good.", remote),
		Run: func(ctx context.Context, env engine.Env) error {
			c := env.Core().Transfers
			if c == nil {
				return errNoCore
			}
			if _, err := c.StartCleanup(ctx, remote+":"); err != nil {
				return err
			}
			env.Status(engine.StatusDone, i18n.T("Cleanup of %s: started.", remote))
			return nil
		}}
}
