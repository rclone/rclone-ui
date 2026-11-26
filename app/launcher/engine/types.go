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
	Text       string
	Terms      []string
	Paths      []Path
	URL        string
	Typing     *Path
	TypingWord string
	TypingFrom int
	Dropped    []Path
	Clipboard  Clip
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
	Text     string
	Remote   string
	Local    bool
	Features map[string]bool
}

func (p Path) Can(feature string) bool { return !p.Local && p.Features[feature] }

func (p Path) Short() string { return shorten(p.Text) }

type Result struct {
	ID       string
	Key      string
	Title    string
	Keywords []string
	English  []string
	Subtitle string
	Icon     icons.Name
	Tail     string
	Score    int
	Actions  []Action
	Always   bool
	Recent   bool
	Complete string
	Pinned   bool
	Group    string

	match []int
}

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

func splitWords(list string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == '，' || r == '、' }) {
		if w = strings.TrimSpace(w); w != "" {
			out = append(out, w)
		}
	}
	return out
}

const (
	GroupSuggested  = "Suggested"
	GroupActive     = "Active"
	GroupOperations = "Operations"
	GroupRemotes    = "Remotes"
	GroupFiles      = "Files"
	GroupApp        = "App"
)

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

func (r Result) Match() []int { return r.match }

func (r *Result) SetMatch(pos []int) { r.match = pos }

func (r Result) Default() (Action, bool) {
	if len(r.Actions) > 0 {
		return r.Actions[0], true
	}
	return Action{}, false
}

type Action struct {
	ID       string
	Name     string
	Icon     icons.Name
	KeepOpen bool
	// Opens marks an action that opens one of the app's windows (Env.OpenWindow, OpenFull). The
	// launcher prepares the focus first (the platform's Activate) while the user's key press is
	// being handled, so the window comes up with the focus.
	Opens   bool
	Stay    bool
	Confirm string
	Run     func(ctx context.Context, env Env) error
}

type StatusKind int

const (
	StatusWorking StatusKind = iota + 1
	StatusDone
)

type Env interface {
	OpenWindow(name, url string)
	OpenFull(name, url string)
	SetQuery(text string)
	Clipboard(text string)
	Reveal(path string)
	OpenURL(url string)
	Notify(title, body string)
	Status(kind StatusKind, text string)
	ClipboardText() string
	Quit()
	Core() Services
}

type Provider interface {
	Query(ctx context.Context, q Query, d *Data) []Result
}

type Streamer interface {
	QueryStream(ctx context.Context, q Query, d *Data, partial func([]Result)) []Result
}

type Data struct {
	Home       string
	Remotes    []Remote
	Mounts     []mounts.MountRow
	Serves     []serves.ServeRow
	Vfs        []vfs.VFS
	Tunnel     bool
	Transfers  []transfers.Transfer
	Failed     []transfers.Transfer
	ServeTypes []string
	List       func(ctx context.Context, dir string, page func([]Entry)) error
}

type Remote struct {
	Name, Type string
	Features   map[string]bool
}

type Entry struct {
	Name string
	Path string
	Dir  bool
}

type Usage map[string]Use

type Use struct {
	Count   int
	Last    time.Time
	Queries []string
}
