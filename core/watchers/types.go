package watchers

import "github.com/rclone/rclone-ui/core/i18n"

// Watcher is a watcher as the pages see it: two folders that a bisync keeps the same every
// minute, and how its runs went. A run in progress isn't shown: a watcher is always syncing.
// Times are in milliseconds since the epoch.
type Watcher struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PathA     string `json:"pathA"`
	PathB     string `json:"pathB"`
	Paused    bool   `json:"paused"`
	CreatedAt int64  `json:"createdAt"`

	// Baselined is set once a resync (a merge of the two folders) has succeeded for these two
	// paths. Until then, each run is a resync.
	Baselined bool `json:"baselined"`
	// LastRunAt is when the last run ended. It is nil until the first run ends.
	LastRunAt *int64 `json:"lastRunAt"`
	// LastResult is how the last run ended: ResultSynced, ResultFailed, or "" before the first
	// run ends.
	LastResult string `json:"lastResult"`
	// LastError is why the last run failed. It is English inside the core, and the API gives it
	// in the app's language.
	LastError string `json:"lastError"`
	// LastChangeAt is when the last run that copied, deleted or renamed a file ended, and
	// LastChangeID is that run's transfer.
	LastChangeAt *int64 `json:"lastChangeAt"`
	LastChangeID string `json:"lastChangeId"`
	// LastTransferID is the last run that History keeps: one that changed something or failed.
	LastTransferID string `json:"lastTransferId"`
	// Attention is why the watcher stopped running until the user acts: AttentionResync,
	// AttentionDeletes, AttentionEmptied, or "" when it runs.
	Attention string `json:"attention"`
	// DeletedSide is the folder that lost many files, for AttentionDeletes and AttentionEmptied:
	// SideA, SideB, or "" when bisync didn't say.
	DeletedSide string `json:"deletedSide"`
	// Resyncing is set from the moment a Resync is asked for until its merge ends. It is not
	// stored. The watcher then shows Initializing, whatever it needed before.
	Resyncing bool `json:"resyncing"`

	lastError i18n.Text // LastError as a translatable text
}

// local returns w with its last error in the app's language, as a page shows it.
func (w *Watcher) local() *Watcher {
	if w != nil {
		w.LastError = w.lastError.Local()
	}
	return w
}

// Input is the form that creates or edits a watcher. An empty ID creates one.
type Input struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	PathA string `json:"pathA"`
	PathB string `json:"pathB"`
}

const (
	ResultSynced = "synced"
	ResultFailed = "failed"
)

// The reasons a watcher needs the user.
const (
	// AttentionResync is a bisync that can only go on after a resync.
	AttentionResync = "resync"
	// AttentionDeletes is bisync's max-delete safety: many files were deleted in one folder.
	AttentionDeletes = "deletes"
	// AttentionEmptied is a folder that lost every file since the last sync. It reads like
	// AttentionDeletes, but bisync won't run with an empty side even with force, so Force syncs
	// the empty folder to the other one instead.
	AttentionEmptied = "emptied"
)

const (
	SideA = "a"
	SideB = "b"
)
