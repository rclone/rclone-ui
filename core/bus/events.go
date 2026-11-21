package bus

// The event names. Each event carries its payload struct, or no data (nil) when it only tells the
// pages what to refetch. The pages get the payload unchanged, as a Wails event with the same
// name. The shell registers each name with its type in app/events.go, so add new events there.
const (
	// Resync tells a subscriber that it fell behind and missed events, so it should read again
	// what it shows. Core.Subscribe sends it. It is never published.
	Resync = "core.resync"

	TransfersChanged     = "transfers.changed"
	TransfersProgress    = "transfers.progress"
	RemotesChanged       = "remotes.changed"
	RemotesHealth        = "remotes.health"
	RemotesSession       = "remotes.session"
	MountsChanged        = "mounts.changed"
	ServesChanged        = "serves.changed"
	TemplatesChanged     = "templates.changed"
	FavoritesChanged     = "favorites.changed"
	NotificationsChanged = "notifications.changed"
	SettingsChanged      = "settings.changed"
	PrefsChanged         = "prefs.changed"
	// ConfigChanged means that the config file's state (such as needing a password, or being
	// unreadable) or its settings changed.
	ConfigChanged = "config.changed"
	TunnelChanged = "tunnel.changed"
	// WatchersChanged means that a watcher was added, changed or removed, or that one of its
	// runs started or ended.
	WatchersChanged = "watchers.changed"
	// AutomountsChanged means that an automount was added, changed or removed.
	AutomountsChanged = "automounts.changed"
	// SchedulesChanged means that a schedule was added, changed or removed, or that one of its
	// runs started or ended.
	SchedulesChanged = "schedules.changed"
	// FilesChanged names entries that were changed in place (FilesChangedData). The panels that
	// show their folders list them again.
	FilesChanged = "files.changed"
	// NotifyOS asks the UI to show an OS notification (NotifyOSData). The core's notification
	// service decides what to notify (notifications.Service.Desktop), and the UI handles the OS
	// side.
	NotifyOS = "notify.os"
)

type PrefsChangedData struct {
	Names []string `json:"names"`
}

// FilesChangedData lists the entries that a file action changed, as full rclone paths. Dirs lists
// the ones that are folders, whose contents changed too.
type FilesChangedData struct {
	Names []string `json:"names"`
	Dirs  []string `json:"dirs,omitempty"`
}

// TransfersChangedData reports that a transfer was created, ended or stopped.
type TransfersChangedData struct {
	ID          string   `json:"id"`
	State       string   `json:"state"`
	Operation   string   `json:"operation"`
	Sources     []string `json:"sources"`
	Destination string   `json:"destination,omitempty"`
}

// TransfersProgressData holds the progress of every running transfer, by transfer id. It is sent
// every second while any transfer runs.
type TransfersProgressData struct {
	Items map[string]TransferProgress `json:"items"`
}

type TransferProgress struct {
	Seq          int64              `json:"seq"`
	State        string             `json:"state"`
	Bytes        int64              `json:"bytes"`
	TotalBytes   int64              `json:"totalBytes"`
	Speed        float64            `json:"speed"`
	Eta          *int64             `json:"eta"` // seconds; null when unknown
	Pct          int                `json:"pct"`
	Files        int64              `json:"files"`
	TotalFiles   int64              `json:"totalFiles"`
	Errors       int64              `json:"errors"`
	Checks       int64              `json:"checks"`
	Listed       int64              `json:"listed"`
	Transferring []TransferringFile `json:"transferring"`
	Checking     []CheckingFile     `json:"checking"`
	Transferred  []TransferredFile  `json:"transferred"` // the last 50
	// Watcher is set for a watcher's run, which the tray's count leaves out.
	Watcher bool `json:"watcher,omitempty"`
}

type TransferringFile struct {
	Name  string  `json:"name"`
	Size  int64   `json:"size"`
	Bytes int64   `json:"bytes"`
	Pct   int     `json:"pct"`
	Speed float64 `json:"speed"`
}

type CheckingFile struct {
	Name string `json:"name"`
}

// TransferredFile is a file that was transferred, or that failed.
type TransferredFile struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Bytes int64  `json:"bytes"`
	Error string `json:"error,omitempty"`
}

// RemotesChangedData lists the remotes that changed, when the publisher knows them. A remote
// counts as changed when it was added, removed or edited, or when it wraps a remote that changed.
// An empty list means "refetch every remote".
type RemotesChangedData struct {
	Names []string `json:"names,omitempty"`
}

// RemotesHealthData reports that a health check of the remote ID finished. State is ok, faulty
// (with rclone's error message), or unknown (when the check got no answer). The quota and the
// advice to reconnect are in the remotes' Health, which the pages refetch after this event.
type RemotesHealthData struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
}

type RemotesSessionData struct {
	ID    string `json:"id"`
	State string `json:"state"`
}

// MountsChangedData reports that a mount started, became ready, failed, stopped, crashed or
// restarted. An event without an ID only means that the list of stopped mounts changed (one was
// mounted again, or discarded), or that WinFsp was installed (mounts.InstallWinFsp), which
// changes mounts.Support. CannotMount comes with a failed mount when this computer can't mount.
// Error is why the mount went down, in the app's language.
type MountsChangedData struct {
	ID          string `json:"id"`
	State       string `json:"state"`
	MountPoint  string `json:"mountPoint,omitempty"`
	Error       string `json:"error,omitempty"`
	CannotMount bool   `json:"cannotMount,omitempty"`
}

// ServesChangedData reports that a serve started, became ready, failed, stopped, crashed or
// restarted. Error is why the serve went down, in the app's language.
type ServesChangedData struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Addr  string `json:"addr,omitempty"`
	Error string `json:"error,omitempty"`
}

// TunnelChangedData reports that the remote tunnel turned on or off, or is starting (or starting
// again). Error explains why a start failed or why the tunnel went down, in the app's language.
// The credentials are only ever in the tunnel's Status.
type TunnelChangedData struct {
	State string `json:"state"`
	Error string `json:"error,omitempty"`
}

// NotifyOSData is the OS notification that NotifyOS asks for. EventID is the id from the
// notification catalog ("job.completed", "mount.failed", …), so the UI can group it or act on it.
// Route is the window that a click on it opens ("/history?id=…"). An empty Route opens nothing.
// ToastOnly means the notification is shown as a toast or not at all. Where the OS can't show
// a toast, the UI drops it rather than show a dialog. This is used for a transfer's end, which
// the Transfers page and the tray also show.
type NotifyOSData struct {
	EventID   string `json:"eventId"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	Route     string `json:"route,omitempty"`
	ToastOnly bool   `json:"toastOnly,omitempty"`
}
