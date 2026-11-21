package linux

import "testing"

// TestPageServiceWithoutAView checks that the page's calls do nothing where the launcher has no
// page (macOS and Windows), or before its view exists, and that Ready says why.
func TestPageServiceWithoutAView(t *testing.T) {
	s := &PageService{View: func() *View { return nil }}
	if _, err := s.Ready(); err != errNoPage {
		t.Fatalf("Ready: %v", err)
	}
	s.Query("x", 1)
	s.Key("enter", "")
	s.Hover(0)
	s.Click(0)
	s.Scroll(1)
	s.StopAll()
	s.Pressed(true)
	s.DragOver(true)
	s.DragStart(1, 2)
	s.DragMove(3, 4)
	s.DragEnd()
}
