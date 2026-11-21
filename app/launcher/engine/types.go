// Package engine holds the launcher's logic, which is the same on every platform. It parses a
// query, asks the providers for results, ranks them (with fuzzy matching and the user's history)
// and runs the action that the user picks. It knows nothing about windows. The launcher passes it
// data and an Env.
package engine

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/app/launcher/icons"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/mounts"
	"github.com/rclone/rclone-ui/core/serves"
	"github.com/rclone/rclone-ui/core/transfers"
	"github.com/rclone/rclone-ui/core/vfs"
)

type Query struct {
	Text string
	// Terms are the words that aren't paths or a URL, in order.
	Terms []string
	Paths []Path
	// URL is the first word that looks like a URL ("https://…", or "example.com/x" with https
	// added).
	URL string
	// Typing is the path that the caret is at the end of (with no space after it), for
	// completion.
	Typing *Path
	// TypingWord is the word that the caret is at the end of, when it isn't a path or a URL.
	TypingWord string
	// TypingFrom is the position in Text where the word being typed starts, including its
	// opening quote. A completion replaces the text from there. It is len(Text) when no word is
	// being typed (the text ends with a space or a closing quote).
	TypingFrom int
	// Dropped are the files dropped on the launcher. The actions apply to them, and the text
	// chooses where they go.
	Dropped   []Path
	Clipboard Clip
}

// Clip is what the launcher knows about the clipboard when it shows. That is either its text, or
// only that it holds a link when reading it would prompt the user (macOS's pasteboard privacy).
// In that case the action reads the clipboard when it runs.
type Clip struct {
	Text string
	Link bool
}

func (q Query) Empty() bool { return len(q.Terms) == 0 && len(q.Paths) == 0 && q.URL == "" }

type Path struct {
	// Text is the path as typed, without quotes. A bare remote name keeps its colon ("gdrive:").
	Text string
	// Remote is the remote's name, or "" for a local path.
	Remote string
	Local  bool
	// Features are the remote's features (FsInfo.features), which say what it can do.
	Features map[string]bool
}

// Can reports whether the path's remote supports feature ("CleanUp", "Purge"). A local path
// never does.
func (p Path) Can(feature string) bool { return !p.Local && p.Features[feature] }

func (p Path) Short() string { return shorten(p.Text) }

// Result is one row that the launcher offers.
type Result struct {
	// ID is unique within a snapshot.
	ID string
	// Key is the key that the user's history is stored under ("remote:gdrive", "op:copy").
	Key string
	// Title is drawn, in the app's language.
	Title string
	// Keywords are matched as well as the title, in the app's language. Only matches in the title
	// are drawn bold.
	Keywords []string
	// English holds the title and the keywords in English, when the app shows another language.
	// They are matched like keywords and never drawn, so that typing "copy" finds Copy in every
	// language. Say fills them.
	English  []string
	Subtitle string
	Icon     icons.Name
	// Tail is grey text on the right, such as a mount point or "3 active".
	Tail string
	// Score is set by the provider. It says how good a result this is before the query's
	// matching and the history are added.
	Score int
	// Actions are what can be done with the result. The first one runs on Enter.
	Actions []Action
	// Always skips matching against the query's words. Completion entries use it, because their
	// path already selected them.
	Always bool
	// Recent marks a result that the empty query shows only when the history says it was used.
	Recent bool
	// Complete is the text that Tab puts in place of the path being typed (a folder entry, a
	// remote's root), or "" for none.
	Complete string
	// Pinned results come first on the empty query, before the recent ones.
	Pinned bool
	// Group is one of the Group constants, or "" for none.
	Group string

	match []int // set by ranking
}

// Say sets r's title and adds its search words from two messages: in the app's language, and in
// English where that differs. A zero title keeps r's Title, which suits a title that is a name.
// words is one message that lists the search words separated by commas ("copy, cp"), so a
// translation can list as many words as its language needs.
func (r Result) Say(title, words i18n.Text) Result {
	if !title.IsZero() {
		r.Title = title.Local()
		r.English = english(r.English, []string{r.Title}, []string{title.String()})
	}
	local, en := Words(words)
	r.Keywords = append(r.Keywords, local...)
	r.English = english(r.English, local, en)
	return r
}

func english(list, local, en []string) []string {
	for _, w := range en {
		if !slices.Contains(local, w) && !slices.Contains(list, w) {
			list = append(list, w)
		}
	}
	return list
}

func Words(words i18n.Text) (local, english []string) {
	return splitWords(words.Local()), splitWords(words.String())
}

// splitWords splits a list of search words on commas, which may be a language's own (Chinese
// "，" and "、").
func splitWords(list string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == '，' || r == '、' }) {
		if w = strings.TrimSpace(w); w != "" {
			out = append(out, w)
		}
	}
	return out
}

// The groups that results are listed in. These values name the groups in the code only.
// GroupTitle returns the label that a group is shown with.
const (
	GroupSuggested  = "Suggested"
	GroupActive     = "Active"
	GroupOperations = "Operations"
	GroupRemotes    = "Remotes"
	GroupFiles      = "Files"
	GroupApp        = "App"
)

// groupOrder is the order in which the empty query shows the groups.
var groupOrder = []string{GroupSuggested, GroupActive, GroupOperations, GroupRemotes, GroupFiles, GroupApp}

func GroupTitle(group string) string {
	switch group {
	case GroupSuggested:
		// i18n: A group of the launcher's rows: what the clipboard suggests.
		return i18n.T("Suggested")
	case GroupActive:
		// i18n: A group of the launcher's rows: what is running now.
		return i18n.T("Active")
	case GroupOperations:
		// i18n: A group of the launcher's rows: copy, sync, mount, and so on.
		return i18n.T("Operations")
	case GroupRemotes:
		// i18n: A group of the launcher's rows: the configured remotes.
		return i18n.T("Remotes")
	case GroupFiles:
		// i18n: A group of the launcher's rows: typed paths and their folders.
		return i18n.T("Files")
	case GroupApp:
		// i18n: A group of the launcher's rows: the app's own screens.
		return i18n.T("App")
	}
	return group
}

// Match returns the positions of the title's runes that the query matched.
func (r Result) Match() []int { return r.match }

// SetMatch sets the runes drawn bold, for a result that ranking doesn't match (Always).
func (r *Result) SetMatch(pos []int) { r.match = pos }

func (r Result) Default() (Action, bool) {
	if len(r.Actions) > 0 {
		return r.Actions[0], true
	}
	return Action{}, false
}

type Action struct {
	ID   string
	Name string // shown in the ⌘K panel and in the footer's ⏎ hint
	Icon icons.Name
	// KeepOpen leaves the launcher up (a drill-in that changes the query).
	KeepOpen bool
	// Opens marks an action that opens one of the app's windows (Env.OpenWindow, OpenFull). The
	// launcher prepares the focus first (the platform's Activate) while the user's key press is
	// being handled, so the window comes up with the focus.
	Opens bool
	// Stay runs the action with the launcher up, for an action that opens no window. Its progress
	// and its outcome are shown in the status corner (Env.Status). So is a failure, and only there.
	Stay bool
	// Confirm, when set, is a question asked in the launcher before the action runs. Only
	// actions that stop or delete something ask, and they are drawn in red.
	Confirm string
	Run     func(ctx context.Context, env Env) error
}

type StatusKind int

const (
	// StatusWorking means the action is in progress: "Unmounting /Volumes/gdrive…".
	StatusWorking StatusKind = iota + 1
	// StatusDone is the outcome: "Unmounted /Volumes/gdrive".
	StatusDone
)

// Env is everything an action may do. The launcher implements it, and tests record the calls.
type Env interface {
	// OpenWindow opens (or reuses) a window for a page at url.
	OpenWindow(name, url string)
	// OpenFull opens a window for a page at the size of the screen (the Commander).
	OpenFull(name, url string)
	// SetQuery replaces the text and keeps the launcher open.
	SetQuery(text string)
	Clipboard(text string)
	// Reveal shows a path in the file manager.
	Reveal(path string)
	OpenURL(url string)
	Notify(title, body string)
	// Status shows what a Stay action is doing, or that it is done, in the launcher's status
	// corner. A status from an earlier action, or one sent after the launcher closed, is dropped.
	// A failure is reported by returning an error from the action instead.
	Status(kind StatusKind, text string)
	// ClipboardText reads the clipboard after the user asked for it.
	ClipboardText() string
	Quit()
	Core() Services
}

type Provider interface {
	// Query returns results for q using d, or nothing. For an empty query it returns what it
	// offers by default (including its Recent results). It must return promptly once ctx is
	// done.
	Query(ctx context.Context, q Query, d *Data) []Result
}

// Streamer is a provider whose results grow while it works, such as the pages of a listing. It
// passes everything found so far to partial each time, and returns the final list. The engine
// uses it instead of Query and treats it as slow, so its results come in a later snapshot rather
// than delaying the first one.
type Streamer interface {
	QueryStream(ctx context.Context, q Query, d *Data, partial func([]Result)) []Result
}

// Data is what the providers read: the core's state, as cached by the launcher.
type Data struct {
	// Home is this machine's home folder, which ~ stands for in a typed path.
	Home    string
	Remotes []Remote
	Mounts  []mounts.MountRow
	Serves  []serves.ServeRow
	Vfs     []vfs.VFS
	// Tunnel is true while the remote tunnel is on or starting.
	Tunnel bool
	// Transfers are the queued and running transfers. Running ones have their Live progress as
	// last read.
	Transfers []transfers.Transfer
	// Failed are the transfers that failed among the last ones to end, newest first, as last
	// read. A provider decides which are recent enough to show.
	Failed     []transfers.Transfer
	ServeTypes []string
	// List lists a folder and passes each page of entries to page as it arrives. It is nil when
	// the core isn't running.
	List func(ctx context.Context, dir string, page func([]Entry)) error
}

type Remote struct {
	Name, Type string
	Features   map[string]bool
}

type Entry struct {
	Name string
	// Path is the entry's full path, written in the same form as the folder's root.
	Path string
	Dir  bool
}

// Usage is the history. It records how often and when each key was picked, and for which
// queries.
type Usage map[string]Use

type Use struct {
	Count   int
	Last    time.Time
	Queries []string
}
