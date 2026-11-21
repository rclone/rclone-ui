package mounts

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone-ui/core/children"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/notifications"
)

const (
	// settleWait limits how long the shutdown waits for stops that users started to settle
	// their caches.
	settleWait = 5 * time.Second
	// cleanWait limits how long the shutdown spends clearing what the children left mounted.
	cleanWait = 10 * time.Second
)

// Boot starts the mounts when the app starts. It runs once, after rclone's init and the
// supervisor. It first starts the mounts that were running before. These are the pending records
// in children.json, kept by a planned restart or left by a previous run that crashed while they
// were running. Then it starts every enabled automount that wasn't already started again. Each
// of these waits until its source responds (see probeBoot).
//
// Failures are logged and notified, and the other mounts still start. On a computer that can't
// mount, Boot logs this once and sends no notifications. If a shutdown happens during Boot (the
// supervisor closes or ctx ends), Boot ends quietly and leaves the pending records to StopAll.
// Boot takes seconds, so run it on its own goroutine (Core.Go).
func (s *Service) Boot(ctx context.Context) {
	all, err := readStored(ctx, s.o.DB)
	if err != nil {
		s.log.ErrorContext(ctx, "could not read the automounts", "error", err)
	}
	automount := enabled(all)
	automountFolders, _ := s.automountFolders(ctx)

	sup := s.o.support()
	resumed := 0
	if !s.reg.Resume(ctx, func(r children.Record) error {
		resumed++
		var m meta
		if err := json.Unmarshal(r.Meta, &m); err != nil || m.Args.Source == "" {
			s.log.WarnContext(ctx, "a mount of the previous run cannot be started again: its arguments are not recorded", "mount_point", r.MountPoint)
			return children.ErrNotRecorded
		}
		if !sup.Supported {
			s.keepIfWaiting(ctx, r, m, automountFolders)
			return unsupported(sup)
		}
		_, err := s.start(ctx, m.Args, startOpts{id: r.ID, automount: m.Automount})
		if err != nil && !children.Closing(ctx, err) {
			s.log.ErrorContext(ctx, "could not start a mount of the previous run again", "source", m.Args.Source, "mount_point", r.MountPoint, "error", err)
			if !notified(err) {
				s.o.Notifier.Notify(ctx, notifications.NotificationEventMountFailed,
					notifications.MountFailed{Source: m.Args.Source, Destination: r.MountPoint, Error: i18n.Localize(err)})
			}
			s.keepIfWaiting(ctx, r, m, automountFolders)
		}
		return err
	}) {
		return // the app is shutting down or restarting, and StopAll keeps the records it chose
	}

	if !sup.Supported {
		if n := len(automount) + resumed; n > 0 {
			s.log.InfoContext(ctx, "mounts are asked for at start, but this computer cannot mount", "count", n, "reason", sup.Reason)
		}
		return
	}
	names := s.o.RemoteNames()
	for _, a := range automount {
		if !slices.Contains(names, a.Remote) {
			s.log.InfoContext(ctx, "an automount's remote is not in the config (or the config is locked)", "remote", a.Remote)
			continue
		}
		if !s.startOnBoot(ctx, a) {
			return
		}
	}
}

// startOnBoot handles one automount. It skips the mount when that source is already mounted
// at that place, because it was started again after the restart. Otherwise it probes the source
// and starts the mount. It returns false when the app is shutting down, so that no more mounts
// are started. Nothing is reported in that case, because the mount didn't fail.
func (s *Service) startOnBoot(ctx context.Context, am Automount) bool {
	if ctx.Err() != nil {
		return false
	}
	remote := am.Remote
	a := am.args()
	m, err := s.o.command(a, s.env(1))
	if err != nil {
		s.log.ErrorContext(ctx, "an automount cannot be built", "remote", remote, "error", err)
		s.o.Notifier.Notify(ctx, notifications.NotificationEventMountFailed,
			notifications.MountFailed{Source: a.Source, Destination: a.Destination, Error: i18n.Localize(err)})
		return true
	}
	for _, c := range s.reg.All() {
		if samePath(c.Own.folder, m.CacheDir, s.o.goos) {
			return true
		}
	}
	if problem, err := s.probeBoot(ctx, remote, am.RemotePath); problem != nil || err != nil {
		if ctx.Err() != nil {
			return false
		}
		failed := notifications.MountFailed{Source: a.Source, Destination: m.MountPoint, Skipped: true}
		if problem != nil {
			// i18n: Why an automount was not mounted at start. The value is a sentence that says what is wrong with its folder.
			failed.Reason = i18n.T("%s Fix its folder in the Automounts window.", problem)
			failed.Error, err = failed.Reason, problem
		} else {
			failed.Error = i18n.Localize(err)
		}
		s.log.WarnContext(ctx, "the source of an automount is not reachable, or is not there; not mounting to avoid an empty folder",
			"source", a.Source, "mount_point", m.MountPoint, "error", err)
		s.o.Notifier.Notify(ctx, notifications.NotificationEventMountFailed, failed)
		s.toast(ctx, notifications.NotificationEventMountFailed, failed)
		return true
	}
	s.log.InfoContext(ctx, "mounting at start", "source", a.Source, "mount_point", m.MountPoint)
	if _, err := s.start(ctx, a, startOpts{automount: true}); err != nil {
		if children.Closing(ctx, err) {
			return false
		}
		s.log.ErrorContext(ctx, "could not automount", "source", a.Source, "error", err)
		if !notified(err) {
			failed := notifications.MountFailed{Source: a.Source, Destination: m.MountPoint, Error: i18n.Localize(err)}
			s.o.Notifier.Notify(ctx, notifications.NotificationEventMountFailed, failed)
			s.toastAs(ctx, i18n.T("Automount failed"), failed.Error)
		}
		return true
	}
	// The mount is up. A source that can't be listed now makes the folder look empty, so warn
	// about a failed listing.
	if err := s.listSource(ctx, remote, am.RemotePath); err != nil && ctx.Err() == nil {
		s.log.WarnContext(ctx, "mounted at start, but listing the source failed", "source", a.Source, "error", err)
		s.toastAs(ctx, i18n.T("Automount may look empty"),
			// i18n: The values are an automount's source and its mount point.
			i18n.T("%s mounted at %s, but listing it failed. The folder may appear empty until the connection recovers.", a.Source, m.MountPoint))
	}
	return true
}

// toast also shows a notification's message as a desktop notification, for automounts. The
// notification targets get the message through Notify.
func (s *Service) toast(ctx context.Context, event notifications.NotificationEvent, p notifications.Payload) {
	s.o.Notifier.Desktop(ctx, event, p, notifications.Desktop{})
}

// toastAs shows a desktop notification only. No notification target receives it.
func (s *Service) toastAs(ctx context.Context, title, body string) {
	s.o.Notifier.Desktop(ctx, notifications.NotificationEventMountFailed, nil, notifications.Desktop{Title: title, Body: body})
}

// probeBoot probes an automount's source until it responds. It waits 1, 2, 4, 8 and then 15 s
// between attempts, for about a minute in total, so that a network that is still coming up at
// boot has time to connect. A source that is wrong (missing, or a file) isn't retried.
func (s *Service) probeBoot(ctx context.Context, remote, remotePath string) (problem, err error) {
	for attempt := 0; ; attempt++ {
		problem, err = s.probeSource(ctx, remote, remotePath)
		if problem != nil || err == nil || attempt >= len(s.o.probeDelays) {
			return problem, err
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(s.o.probeDelays[attempt]):
		}
	}
}

// keepIfWaiting handles a mount from the previous run that isn't started again. When its cache
// holds uploads that rclone hadn't sent, it records the mount in stopped_mounts. It skips the
// folder of an automount (in automount), because that mount comes back and sends them.
func (s *Service) keepIfWaiting(ctx context.Context, r children.Record, m meta, automount map[string]bool) {
	folder := cacheDirOf(r.Args)
	if folder == "" || automount[filepath.Clean(folder)] {
		return
	}
	s.keepWaiting(ctx, s.log.With("mount_point", r.MountPoint),
		waiting{folder: folder, args: m.Args, mountPoint: r.MountPoint}, -1)
}

// cacheDirOf returns the --cache-dir from a mount's recorded arguments, as built by
// operations.MountCommand.
func cacheDirOf(args []string) string {
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, "--cache-dir="); ok {
			return v
		}
	}
	return ""
}

// Shutdown is the mounts' part of the core's shutdown. It runs after Supervisor.StopAll has
// stopped every child.
//
// First it waits, for at most settleWait, for the stops that users started. Each of those
// settles its own cache in the database, which the core closes next. Then it clears what the
// children left mounted (cleanAll), whether or not the mounts come back.
//
// When the mounts won't come back (restore is false, as in a plain quit), Shutdown handles each
// mount that was started by hand, as a user's stop would. If the mount's cache folder holds
// uploads that rclone hadn't sent, the mount is recorded in stopped_mounts and its cache is kept.
// Those uploads are the items rclone marks dirty: queued, or open for writing when the mount
// stopped. An automount is skipped, because it comes back anyway and sends them. This check
// runs after the children have stopped, because reading the queue earlier would miss files that
// were still open, and files closed in the meantime.
func (s *Service) Shutdown(ctx context.Context, restore bool) {
	if !s.reg.WaitStops(ctx, settleWait) {
		s.log.WarnContext(ctx, "a mount being stopped had not settled its cache", "waited", settleWait)
	}
	s.cleanAll(ctx)
	if restore {
		return
	}
	var left []*child
	for _, c := range s.reg.Live() { // a user's stop settles its own cache
		if c.Unit() != nil && !c.Own.automount {
			left = append(left, c)
		}
	}
	if len(left) == 0 {
		return
	}
	automount, ok := s.automountFolders(ctx)
	if !ok {
		return
	}
	for _, c := range left {
		if !automount[filepath.Clean(c.Own.folder)] {
			s.keepWaiting(ctx, c.Log, waitingOf(c), -1)
		}
	}
}

// cleanAll force-unmounts what the stopped children left mounted. That happens when a child was
// killed after its grace period (a dead NFS mount on macOS), or when the OS refused an unmount (a
// shell inside the mount on Linux). The next start only clears the mount points that
// children.json still records, and a quit records none. cleanAll handles every mount in the
// registry at once, for at most cleanWait. It clears only the mount point, and leaves the record
// and the cache so that an update's restart can bring the mount back.
func (s *Service) cleanAll(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, cleanWait)
	defer cancel()
	var wg sync.WaitGroup
	for _, c := range s.reg.All() {
		wg.Go(func() { s.cleanMountPoint(ctx, c) })
	}
	if !syncx.Wait(ctx, &wg, cleanWait) {
		s.log.WarnContext(ctx, "clearing the mount points the mounts left took too long", "waited", cleanWait)
	}
}
