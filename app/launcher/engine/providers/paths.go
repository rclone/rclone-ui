package providers

import (
	"context"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/core/i18n"
)

// Paths offers each typed path. The default action browses it in the Commander, and the ⌘K panel
// lists every operation that can start from it.
type Paths struct{}

func (Paths) Query(_ context.Context, q engine.Query, d *engine.Data) []engine.Result {
	var out []engine.Result
	for _, p := range q.Paths {
		arg := pathArg(p)
		// i18n: %s is a remote's name.
		subtitle := i18n.T("Browse files and folders in %s.", p.Remote)
		if p.Local {
			subtitle = i18n.T("Browse files and folders on this machine.")
		}
		// i18n: %s is a path.
		title := i18n.M("Browse %s", p.Short())
		out = append(out, engine.Result{
			ID: "path:" + arg, Key: pathKey(arg), Subtitle: subtitle, Icon: icons.Folder, Score: 165,
			Actions: append(pathActions(p, d, true), copyText("copy-path", i18n.T("Copy Path"), arg)),
		}.Say(title, pathWords))
	}
	return inGroup(engine.GroupFiles, out)
}

var (
	// i18n: Search words for the launcher's row that browses a typed path, separated by commas. Add any word that people would type to find it.
	pathWords = i18n.M("browse, open, view, files")
)

// pathActions returns every operation that can start from p. It is used for the ⌘K panel of a
// typed path, a remote and a listed entry. A file (dir false) gets only the operations that accept
// a file. The caller adds the action that copies the path, because it chooses its name.
func pathActions(p engine.Path, d *engine.Data, dir bool) []engine.Action {
	arg := pathArg(p)
	var out []engine.Action
	if dir {
		out = append(out, browse(arg))
	}
	// i18n: Actions on a path, which open the operation's window with the path as its source.
	out = append(out, from(copyOp, p, i18n.T("Copy From")), from(moveOp, p, i18n.T("Move From")))
	if dir {
		out = append(out,
			from(syncOp, p, i18n.T("Sync From")),
			from(bisyncOp, p, i18n.T("Bisync From")),
			// i18n: An action on a folder, which opens the Download window with the folder as where the file goes.
			named(open("download", "Download", "/download", icons.Download, "initialDestination", arg), i18n.T("Download Here")),
			from(mountOp, p, i18n.T("Mount")),
			from(serveOp, p, i18n.T("Serve")),
		)
	}
	out = append(out, from(deleteOp, p, i18n.T("Delete")))
	if dir && p.Can("Purge") {
		out = append(out, from(purgeOp, p, i18n.T("Purge")))
	}
	if p.Can("CleanUp") {
		out = append(out, cleanup(p.Remote))
	}
	if !p.Local {
		out = append(out, remotesWindow("edit", i18n.T("Edit Remote"), "edit", p.Remote))
		if dir {
			out = append(out, newAutomount(p.Text))
		}
	}
	if p.Local {
		// i18n: An action that shows a file or folder in the file manager (Finder, Explorer).
		out = append(out, engine.Action{ID: "reveal", Name: i18n.T("Reveal"), Icon: icons.Reveal,
			Run: func(_ context.Context, env engine.Env) error {
				env.Reveal(p.Text)
				return nil
			}})
	}
	return out
}
