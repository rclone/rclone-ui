package agents

import (
	"context"
	"runtime"
	"slices"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type about struct {
	AppVersion    string `json:"app_version"`
	RcloneVersion string `json:"rclone_version"`
	OS            string `json:"os" jsonschema:"darwin, windows or linux: the form of local paths follows from it"`
	// CanMount is false when this computer lacks what a mount needs (WinFsp, macFUSE or FUSE).
	CanMount bool `json:"can_mount"`
	// MountHelp says what is missing when the computer can't mount.
	MountHelp string `json:"mount_help,omitempty"`
}

type remote struct {
	Name        string `json:"name" jsonschema:"the remote's name: its root is the path name followed by a colon"`
	Type        string `json:"type" jsonschema:"rclone's backend, such as drive, s3 or sftp"`
	State       string `json:"state,omitempty" jsonschema:"ok (reachable), checking (being checked now), unknown (it didn't answer in time) or faulty (it failed: see error); empty when it hasn't been checked yet"`
	Error       string `json:"error,omitempty" jsonschema:"why the remote can't be used, when it can't"`
	NeedsSignIn bool   `json:"needs_sign_in,omitempty" jsonschema:"true when the user must sign in to the remote again, in the app's Remotes window; an agent can't do it for them"`
	// UsedBytes, FreeBytes and TotalBytes are the remote's storage, where it reports them.
	UsedBytes  *int64 `json:"used_bytes,omitempty"`
	FreeBytes  *int64 `json:"free_bytes,omitempty"`
	TotalBytes *int64 `json:"total_bytes,omitempty"`
}

type remoteList struct {
	Remotes []remote `json:"remotes"`
}

type nothing struct{}

func (s *Server) infoTools() {
	add(s, &mcp.Tool{
		Name:        "about",
		Description: "Rclone UI's and rclone's versions, this computer's OS, and whether it can mount remotes as drives.",
		Annotations: reads("About Rclone UI"),
	}, func(ctx context.Context, _ nothing) (about, error) {
		info, err := s.o.APIs.App.Info(ctx)
		if err != nil {
			return about{}, err
		}
		out := about{AppVersion: info.AppVersion, RcloneVersion: info.RcloneVersion, OS: runtime.GOOS}
		if sup, err := s.o.APIs.Mounts.Support(ctx); err == nil {
			out.CanMount, out.MountHelp = sup.Supported, sup.Reason
		}
		return out, nil
	})

	add(s, &mcp.Tool{
		Name: "list_remotes",
		Description: "The user's remotes (their connected storage): each one's name, its type, whether it is reachable, and its storage use. " +
			"A remote's files are at \"name:path\". Remotes are added, changed and signed in to by the user, in the app's Remotes window.",
		Annotations: reads("List remotes"),
	}, func(ctx context.Context, _ nothing) (remoteList, error) {
		list, err := s.o.APIs.Remotes.List(ctx)
		if err != nil {
			return remoteList{}, err
		}
		// The health is what the app last found. A remote that was never checked has none.
		health, _ := s.o.APIs.Remotes.Health(ctx)
		out := remoteList{Remotes: make([]remote, 0, len(list))}
		for _, r := range list {
			item := remote{Name: r.Name, Type: r.Type}
			if h, ok := health[r.Name]; ok {
				item.State, item.Error, item.NeedsSignIn = h.State, h.Error, h.CanReconnect
				if q := h.About; q != nil {
					item.UsedBytes, item.FreeBytes, item.TotalBytes = q.Used, q.Free, q.Total
				}
			}
			out.Remotes = append(out.Remotes, item)
		}
		slices.SortFunc(out.Remotes, func(a, b remote) int {
			if a.Name < b.Name {
				return -1
			}
			if a.Name > b.Name {
				return 1
			}
			return 0
		})
		return out, nil
	})
}
