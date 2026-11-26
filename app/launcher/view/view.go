package view

import (
	"time"

	"github.com/rclone/rclone-ui/app/launcher/icons"
)

type View interface {
	Show(at *Placement)
	Hide()
	Render(s Snapshot)
	SetQuery(text string, selectAll bool)
	Visible() bool
}

type Activator interface {
	SetActivationToken(token string)
}

type Events struct {
	Query    func(text string)
	Key      func(k KeyEvent) bool
	Hover    func(row int)
	Click    func(row int)
	Scroll   func(rows int)
	Moved    func(at Placement)
	Blur     func()
	Drop     func(paths []string)
	StopAll  func()
	Panicked func(where string, v any)
}

type Key int

const (
	KeyNone Key = iota
	KeyUp
	KeyDown
	KeyEnter
	KeyEsc
	KeyTab
	KeyActions
	KeyRow
	KeyClose
)

type KeyEvent struct {
	Key  Key
	Char rune
}

type Placement struct {
	Left float64 `json:"left"`
	Top  float64 `json:"top"`
}

type Snapshot struct {
	Placeholder string `json:"placeholder"`
	Header      string `json:"header"`
	Rows        []Row  `json:"rows"`
	Selected    int    `json:"selected"`
	More        bool   `json:"more"`
	Footer      []Hint `json:"footer"`
	Status      Status `json:"status"`
	Running     bool   `json:"running"`
}

type Row struct {
	Group    string     `json:"group"`
	Icon     icons.Name `json:"icon"`
	Title    string     `json:"title"`
	Bold     []int      `json:"bold"`
	Subtitle string     `json:"subtitle"`
	Tail     string     `json:"tail"`
	Hint     string     `json:"hint"`
	Danger   bool       `json:"danger"`
}

type Status struct {
	Kind StatusKind `json:"kind"`
	Text string     `json:"text"`
}

type StatusKind int

const (
	StatusNone StatusKind = iota
	StatusLoading
	StatusDone
	StatusError
)

type Line struct {
	Status Status `json:"status"`
	Hints  string `json:"hints"`
}

func FooterLine(s Snapshot) Line {
	if s.Status.Kind != StatusNone {
		return Line{Status: s.Status}
	}
	return Line{Hints: FooterText(s.Footer)}
}

func Swaps(a, b Line) bool {
	return a != b && (a.Status.Kind != StatusNone || b.Status.Kind != StatusNone)
}

const SwapFor = 200 * time.Millisecond

type Hint struct {
	Keys  string `json:"keys"`
	Label string `json:"label"`
}

const RowLetters = "bdefgijlnoprstu"

const StopAllChar = '.'

const MaxRows = 8
