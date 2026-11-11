package providers

import (
	"context"

	"github.com/rclone/rclone-ui/app/launcher/engine"
	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/core/i18n"
)

// Clipboard suggests what was just copied, on the empty query: a link to download, or a path to
// browse. When the clipboard can't be read without asking the user (macOS), only the fact that it
// holds a link is known. The action then reads the clipboard once the user has chosen it.
type Clipboard struct{}

func (Clipboard) Query(_ context.Context, q engine.Query, d *engine.Data) []engine.Result {
	if !q.Empty() || len(q.Dropped) > 0 {
		return nil
	}
	if q.Clipboard.Text == "" {
		if !q.Clipboard.Link {
			return nil
		}
		return []engine.Result{{
			ID: "clip:link", Key: "clip:download", Title: i18n.T("Download the Link You Copied"), Subtitle: i18n.T("From the clipboard."),
			Icon: icons.Download, Pinned: true, Group: engine.GroupSuggested,
			Actions: []engine.Action{{ID: "download", Name: openName("Download"), Icon: icons.Download, Opens: true,
				Run: func(_ context.Context, env engine.Env) error {
					// if it isn't a link after all, the window opens empty
					link, _, _ := engine.ReadClip(env.ClipboardText(), nil, "")
					env.OpenWindow("Download", withParams("/download", "initialUrl", link))
					return nil
				}}},
		}}
	}
	link, p, ok := engine.ReadClip(q.Clipboard.Text, d.Remotes, d.Home)
	switch {
	case !ok:
		return nil
	case link != "":
		return []engine.Result{{
			ID: "clip:link", Key: "clip:download", Title: downloadOp.on(urlLabel(link)).Local(), Subtitle: link,
			Icon: icons.Download, Pinned: true, Group: engine.GroupSuggested,
			Actions: []engine.Action{open("download", "Download", "/download", icons.Download, "initialUrl", link)},
		}}
	}
	arg := pathArg(p)
	return []engine.Result{{
		// i18n: %s is a path that was copied to the clipboard.
		ID: "clip:path", Key: "clip:browse", Title: i18n.T("Browse %s", p.Short()), Subtitle: i18n.T("Copied: %s", arg),
		Icon: icons.Folder, Pinned: true, Group: engine.GroupSuggested,
		Actions: []engine.Action{
			browse(arg),
			named(open("copy", "Copy", "/copy", icons.Copy, "initialSource", arg), i18n.T("Copy From")),
			copyText("copy-path", i18n.T("Copy Path"), arg),
		},
	}}
}
