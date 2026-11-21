package linux

import "errors"

// PageService receives what the user does on the launcher's page (src/pages/Launcher), and passes
// it on to the view. The app binds it on every OS, so that the bindings are the same everywhere.
// The launcher is native on macOS and Windows, where no page calls it, and its methods do nothing.
type PageService struct {
	// View returns the launcher's view, or nil where the launcher has no page or until the view
	// exists.
	View func() *View
}

var errNoPage = errors.New("the launcher isn't drawn by a page here")

func (s *PageService) Ready() (Init, error) {
	if v := s.View(); v != nil {
		return v.Ready(), nil
	}
	return Init{}, errNoPage
}

// Query receives the query box's text after an edit, with the number of the edit.
func (s *PageService) Query(text string, seq int) { s.with(func(v *View) { v.Query(text, seq) }) }

// Key receives a key that the page leaves to the launcher: up, down, enter, esc, tab, actions,
// or row with the character that was pressed with Ctrl.
func (s *PageService) Key(key, char string) { s.with(func(v *View) { v.Key(key, char) }) }

// Hover receives the row under the pointer when the pointer moves over the rows.
func (s *PageService) Hover(row int) { s.with(func(v *View) { v.Hover(row) }) }

func (s *PageService) Click(row int) { s.with(func(v *View) { v.Click(row) }) }

// Scroll receives the rows scrolled with the wheel or the touchpad. Positive is down.
func (s *PageService) Scroll(rows int) { s.with(func(v *View) { v.Scroll(rows) }) }

func (s *PageService) StopAll() { s.with(func(v *View) { v.StopAll() }) }

// Pressed receives whether a pointer button is down in the window.
func (s *PageService) Pressed(down bool) { s.with(func(v *View) { v.Pressed(down) }) }

// DragOver receives whether files are being dragged over the window.
func (s *PageService) DragOver(over bool) { s.with(func(v *View) { v.DragOver(over) }) }

// DragStart receives a press that starts moving a layer surface, at (x, y) in the window.
func (s *PageService) DragStart(x, y float64) { s.with(func(v *View) { v.DragStart(x, y) }) }

// DragMove receives the pointer's position while a layer surface moves.
func (s *PageService) DragMove(x, y float64) { s.with(func(v *View) { v.DragMove(x, y) }) }

func (s *PageService) DragEnd() { s.with(func(v *View) { v.DragEnd() }) }

func (s *PageService) with(fn func(v *View)) {
	if v := s.View(); v != nil {
		fn(v)
	}
}
