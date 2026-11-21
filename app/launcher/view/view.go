// Package view defines the contract between the launcher and the window that each platform
// draws it in. The launcher makes every decision: the selection, what a key does, when to hide
// and where to open. A view draws a Snapshot and reports what the user does. Every method runs on
// the main thread, and every event is called on it.
package view

import (
	"time"

	"github.com/rclone/rclone-ui/app/launcher/icons"
)

type View interface {
	// Show gives the window keyboard focus. A nil at centres the window on the screen that has
	// the mouse. Otherwise the window opens at at, if that spot is still on a screen.
	Show(at *Placement)
	// Hide keeps the query box's text.
	Hide()
	// Render resizes the window to fit the rows and keeps the top edge in place.
	Render(s Snapshot)
	// SetQuery puts the caret at the end of the text unless selectAll is set.
	SetQuery(text string, selectAll bool)
	Visible() bool
}

// Activator is a view that can take focus using the activation token that the compositor
// issued for the shortcut press (Wayland's xdg-activation). The Linux view implements it when
// its window is a native Wayland window.
type Activator interface {
	// SetActivationToken sets the token to use for the next Show.
	SetActivationToken(token string)
}

type Events struct {
	Query func(text string)
	// Key offers a key to the launcher. Returning false passes it on to the query box.
	Key func(k KeyEvent) bool
	// Hover is called only when the mouse moves, not when rows shift under a pointer that stays
	// still.
	Hover func(row int)
	Click func(row int)
	// Scroll receives the number of rows scrolled. Positive is down.
	Scroll func(rows int)
	Moved  func(at Placement)
	// Blur is called when the window loses keyboard focus. A view may delay it while a mouse
	// button is down, so that a drag that started in another window can still be dropped on
	// this one.
	Blur func()
	Drop func(paths []string)
	// StopAll is called when the stop-everything button is pressed, even when nothing is running.
	StopAll func()
	// Panicked receives a panic that the view recovered in a toolkit callback, with where it
	// happened and the panic value. The view must recover there because a panic can't unwind
	// through the toolkit's frames. It is called from the deferred recover, so the panicking
	// frames are still on the stack for the report. It may be called on any thread.
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
	// KeyActions is ⌘K (Ctrl+K on Windows and Linux).
	KeyActions
	// KeyRow is ⌘ (Ctrl) with a digit or a letter. KeyEvent.Char holds which one.
	KeyRow
	// KeyClose is sent when the window is closed, with Alt+F4 or the window manager's close
	// button. It dismisses the launcher even in states that Esc would only step back from.
	KeyClose
)

// KeyEvent is a key press. Char holds the lower-case character of a KeyRow.
type KeyEvent struct {
	Key  Key
	Char rune
}

// Placement is where the user left the window, as its left and top edges in the view's own
// screen coordinates.
type Placement struct {
	Left float64 `json:"left"`
	Top  float64 `json:"top"`
}

type Snapshot struct {
	Placeholder string `json:"placeholder"`
	// Header, when set, is a line above the rows that names the item whose actions are shown.
	Header string `json:"header"`
	// Rows are the rows to draw: as many rows of the list as fit in MaxListH.
	Rows []Row `json:"rows"`
	// Selected is the highlighted row, -1 for none.
	Selected int `json:"selected"`
	// More reports that the list has more rows than those drawn. The list then keeps its full
	// height, so the window doesn't change size while scrolling.
	More   bool   `json:"more"`
	Footer []Hint `json:"footer"`
	// Status, when set, replaces the hints in the footer.
	Status Status `json:"status"`
	// Running makes the stop-everything button red rather than muted.
	Running bool `json:"running"`
}

type Row struct {
	// Group is the label of the group that starts at this row, drawn above it. It is empty
	// when the row doesn't start a group.
	Group    string     `json:"group"`
	Icon     icons.Name `json:"icon"`
	Title    string     `json:"title"`
	Bold     []int      `json:"bold"` // indexes of the runes in Title that matched the query, drawn bold
	Subtitle string     `json:"subtitle"`
	Tail     string     `json:"tail"` // grey text at the right: "3 active", a mount point
	Hint     string     `json:"hint"` // the row's shortcut: "⌘1"
	// Danger marks a row that stops or deletes something. Its icon and its selection are red.
	Danger bool `json:"danger"`
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
	Status Status `json:"status"` // StatusNone means the hints are shown
	Hints  string `json:"hints"`
}

func FooterLine(s Snapshot) Line {
	if s.Status.Kind != StatusNone {
		return Line{Status: s.Status}
	}
	return Line{Hints: FooterText(s.Footer)}
}

// Swaps reports whether the footer animates from line a to line b. It animates when either line
// is a status. A change from hints to other hints doesn't animate.
func Swaps(a, b Line) bool {
	return a != b && (a.Status.Kind != StatusNone || b.Status.Kind != StatusNone)
}

// SwapFor is how long the footer animation takes. It eases out.
const SwapFor = 200 * time.Millisecond

// Hint is a key and what it does, such as {"⏎", "Browse"}.
type Hint struct {
	Keys  string `json:"keys"`
	Label string `json:"label"`
}

// RowLetters are the letters that run rows with ⌘ (Ctrl), after ⌘1–9. They leave out A, C, V
// and X (clipboard), K (actions), and the keys used by the app and the text box: Q (quit), W
// (close), H (hide), M (minimise), Z and Y (undo, redo).
const RowLetters = "bdefgijlnoprstu"

// MaxRows is the most rows a view shows at once, or fewer when group labels sit between them.
// The user reaches the rest by moving the selection or scrolling.
const MaxRows = 8
