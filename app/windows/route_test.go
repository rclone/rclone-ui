package windows

import "testing"

func TestForRoute(t *testing.T) {
	for _, tc := range []struct {
		url, name string
		shape     Shape
	}{
		{"/", "Main", Standard},
		{"", "Main", Standard},
		{"/commander?path=x", "Commander", Full},
		{"/commander?left=/tmp", "Commander", Full},
		{"/startup", "Startup", Small},
		{"/settings?tab=about", "Settings", Standard},
		{"/history/", "History", Standard},
		{"/copy", "Copy", Standard},
	} {
		if name, shape := ForRoute(tc.url); name != tc.name || shape != tc.shape {
			t.Errorf("%s: %s %v", tc.url, name, shape)
		}
	}
}
