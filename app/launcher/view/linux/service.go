package linux

import "errors"

type PageService struct {
	View func() *View
}

var errNoPage = errors.New("the launcher isn't drawn by a page here")

func (s *PageService) Ready() (Init, error) {
	if v := s.View(); v != nil {
		return v.Ready(), nil
	}
	return Init{}, errNoPage
}

func (s *PageService) Query(text string, seq int) { s.with(func(v *View) { v.Query(text, seq) }) }

// Key receives a key that the page leaves to the launcher: up, down, enter, esc, tab, actions,
// or row with the character that was pressed with Ctrl.
func (s *PageService) Key(key, char string) { s.with(func(v *View) { v.Key(key, char) }) }

func (s *PageService) Hover(row int) { s.with(func(v *View) { v.Hover(row) }) }

func (s *PageService) Click(row int) { s.with(func(v *View) { v.Click(row) }) }

// Scroll receives the rows scrolled with the wheel or the touchpad. Positive is down.
func (s *PageService) Scroll(rows int) { s.with(func(v *View) { v.Scroll(rows) }) }

func (s *PageService) StopAll() { s.with(func(v *View) { v.StopAll() }) }

func (s *PageService) Pressed(down bool) { s.with(func(v *View) { v.Pressed(down) }) }

func (s *PageService) DragOver(over bool) { s.with(func(v *View) { v.DragOver(over) }) }

func (s *PageService) DragStart(x, y float64) { s.with(func(v *View) { v.DragStart(x, y) }) }

func (s *PageService) DragMove(x, y float64) { s.with(func(v *View) { v.DragMove(x, y) }) }

func (s *PageService) DragEnd() { s.with(func(v *View) { v.DragEnd() }) }

func (s *PageService) with(fn func(v *View)) {
	if v := s.View(); v != nil {
		fn(v)
	}
}
