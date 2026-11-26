package providers

import (
	"context"
	"path/filepath"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/core/i18n"
)

type Dropped struct{}

func (Dropped) Query(_ context.Context, q engine.Query, d *engine.Data) []engine.Result {
	if len(q.Dropped) == 0 {
		return nil
	}
	label := droppedLabel(q.Dropped)
	folder := len(q.Dropped) == 1 && isDir(q.Dropped[0].Text)
	var out []engine.Result
	if len(q.Paths) > 0 {
		dest := pathArg(q.Paths[len(q.Paths)-1])
		short := q.Paths[len(q.Paths)-1].Short()
		// i18n: %[1]s is what was dropped on the launcher (a file's name, or "3 items"), and %[2]s where it goes.
		copyTo := i18n.T("Copy %[1]s to %[2]s", label, short)
		out = append(out,
			droppedResult("copy-to", copyTo, dest, icons.Copy, 200, transferTo("copy", "Copy", q.Dropped, dest), transferTo("move", "Move", q.Dropped, dest)),
			droppedResult("move-to", i18n.T("Move %[1]s to %[2]s", label, short), dest, icons.Move, 190, transferTo("move", "Move", q.Dropped, dest)),
		)
		if folder {
			out = append(out, droppedResult("sync-to", i18n.T("Sync %[1]s to %[2]s", label, short), dest, icons.Sync, 180, transferTo("sync", "Sync", q.Dropped, dest)))
		}
	} else {
		for _, r := range d.Remotes {
			root := r.Name + ":"
			// i18n: %s is a remote's type, such as "drive" or "s3".
			sub := i18n.T("To the %s remote. Press Tab to open subfolders.", r.Type)
			res := droppedResult("remote:"+r.Name, i18n.T("Copy %[1]s to %[2]s", label, root), sub, icons.Remote, 100,
				transferTo("copy", "Copy", q.Dropped, root), transferTo("move", "Move", q.Dropped, root))
			res.Key = historyKey("drop:remote", r.Name)
			res.Keywords = []string{r.Name, r.Type}
			res.Complete = root
			out = append(out, res)
		}
	}
	// i18n: %s is what was dropped on the launcher: a file's name, or "3 items". The window that opens asks where it goes.
	copyWhere := i18n.T("Copy %s to…", label)
	out = append(out,
		droppedResult("copy", copyWhere, i18n.T("Choose where, in the Copy window."), icons.Copy, 60, transferTo("copy", "Copy", q.Dropped, "")),
		droppedResult("move", i18n.T("Move %s to…", label), i18n.T("Choose where, in the Move window."), icons.Move, 58, transferTo("move", "Move", q.Dropped, "")),
	)
	if folder {
		f := q.Dropped[0].Text
		s := open("serve", "Serve", "/serve", icons.Serve, "initialSource", f)
		s.Name = i18n.T("Serve")
		out = append(out,
			droppedResult("sync", i18n.T("Sync %s to…", label), i18n.T("Choose where, in the Sync window."), icons.Sync, 56, transferTo("sync", "Sync", q.Dropped, "")),
			droppedResult("serve",
				// i18n: %s is the name of the folder that was dropped on the launcher.
				i18n.T("Serve %s", label),
				i18n.T("Over HTTP, WebDAV, SFTP and more."), icons.Serve, 54, s),
			droppedResult("browse", i18n.T("Browse %s", label), i18n.T("Open it in the Commander."), icons.Folder, 52, browse(f)),
		)
	}
	return out
}

func droppedResult(id, title, subtitle string, icon icons.Name, score int, actions ...engine.Action) engine.Result {
	return engine.Result{ID: "drop:" + id, Key: "drop:" + id, Title: title, Subtitle: subtitle, Icon: icon,
		Score: score, Actions: actions}
}

func transferTo(id, name string, sources []engine.Path, dest string) engine.Action {
	params := make([]string, 0, 2*len(sources)+2)
	for _, s := range sources {
		params = append(params, "initialSource", s.Text)
	}
	params = append(params, "initialDestination", dest)
	a := open(id, name, "/"+id, map[string]icons.Name{"copy": icons.Copy, "move": icons.Move, "sync": icons.Sync}[id], params...)
	a.Name = transferName(id, dest != "")
	return a
}

func transferName(id string, here bool) string {
	switch {
	case id == "move" && here:
		// i18n: An action that moves the files that were dropped on the launcher into the selected folder.
		return i18n.T("Move Here")
	case id == "move":
		return i18n.T("Move")
	case id == "sync" && here:
		return i18n.T("Sync Here")
	case id == "sync":
		return i18n.T("Sync")
	case here:
		// i18n: An action that copies the files that were dropped on the launcher into the selected folder.
		return i18n.T("Copy Here")
	}
	return i18n.T("Copy")
}

func droppedLabel(ps []engine.Path) any {
	if len(ps) == 1 {
		return filepath.Base(ps[0].Text)
	}
	// i18n: What was dropped on the launcher, inside a longer line such as "Copy 3 items to gdrive:".
	return i18n.MN("%d item", "%d items", len(ps), len(ps))
}
