package windows

import "testing"

func TestCascade(t *testing.T) {
	area := Area{X: 0, Y: 25, Width: 1440, Height: 875}
	cases := []struct {
		open, x, y int
	}{
		{0, 300, 100},
		{1, 280, 80},
		{2, 340, 140},
		{3, 240, 40},
	}
	for _, c := range cases {
		x, y := Cascade(area, 840, 725, c.open)
		if x != c.x || y != c.y {
			t.Errorf("Cascade(open=%d) = %d,%d, want %d,%d", c.open, x, y, c.x, c.y)
		}
	}
}

func TestCascadeStaysOnScreen(t *testing.T) {
	area := Area{X: 1920, Y: 0, Width: 1280, Height: 800}
	for open := range 40 {
		x, y := Cascade(area, 840, 725, open)
		if x < area.X || x+840 > area.X+area.Width || y < area.Y || y+725 > area.Y+area.Height {
			t.Fatalf("open=%d: %d,%d leaves the area", open, x, y)
		}
	}
	// A window larger than the area is pinned to its top-left corner.
	if x, y := Cascade(Area{Width: 600, Height: 400}, 840, 725, 3); x != 0 || y != 0 {
		t.Errorf("oversized window at %d,%d", x, y)
	}
}
