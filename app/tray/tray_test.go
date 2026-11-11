package tray

import (
	"bytes"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

// The submenus that the UI adds while mounts and serves run (see SetRunning).
var (
	mounts = Item{Label: "Mounts (1)", Children: []Item{{Label: "gdrive: → /Volumes/gdrive", Children: []Item{{Label: "Open"}, {Label: "Unmount"}}}}}
	serves = Item{Label: "Serves (2)", Children: []Item{{Label: "WEBDAV :8080"}, {Label: "HTTP :8081"}, {Separator: true}, {Label: "Stop All"}}}
)

// render writes a menu's items on one line, with "-" for a separator and "▸" after a submenu.
func render(items []Item) string {
	parts := make([]string, len(items))
	for i, it := range items {
		switch {
		case it.Separator:
			parts[i] = "-"
		case len(it.Children) > 0:
			parts[i] = it.Label + " ▸"
		default:
			parts[i] = it.Label
		}
	}
	return strings.Join(parts, " | ")
}

func TestLayout(t *testing.T) {
	const history = "History (2 running · 27%)"
	for _, c := range []struct {
		name  string
		state state
		want  string
		at    int // the History item's index
	}{
		{"nothing active", state{},
			"Open | - | Guide | GitHub | Quit", -1},
		{"only transfers", state{transfers: history},
			"Open | - | History (2 running · 27%) | - | Guide | GitHub | Quit", 2},
		{"only mounts", state{running: []Item{mounts}},
			"Open | - | Mounts (1) ▸ | - | Guide | GitHub | Quit", -1},
		{"only serves", state{running: []Item{serves}},
			"Open | - | Serves (2) ▸ | - | Guide | GitHub | Quit", -1},
		{"mounts and serves", state{running: []Item{mounts, serves}},
			"Open | - | Mounts (1) ▸ | Serves (2) ▸ | - | Guide | GitHub | Quit", -1},
		{"all three", state{transfers: history, running: []Item{mounts, serves}},
			"Open | - | History (2 running · 27%) | Mounts (1) ▸ | Serves (2) ▸ | - | Guide | GitHub | Quit", 2},
	} {
		items, at := layout(c.state, Actions{})
		got := render(items)
		t.Logf("%-19s %s", c.name+":", got)
		if got != c.want || at != c.at {
			t.Errorf("%s: %s (History at %d)\nwant %s (History at %d)", c.name, got, at, c.want, c.at)
			continue
		}
		for _, it := range items {
			if it.Disabled {
				t.Errorf("%s: %q is disabled", c.name, it.Label)
			}
			// The UI's submenus are shown as the UI gave them.
			if it.Label == mounts.Label && render(it.Children) != render(mounts.Children) ||
				it.Label == serves.Label && render(it.Children) != render(serves.Children) {
				t.Errorf("%s: %q has %s", c.name, it.Label, render(it.Children))
			}
		}
	}
}

func TestLayoutActions(t *testing.T) {
	var ran []string
	a := Actions{
		ShowLauncher: func() { ran = append(ran, "launcher") },
		Open:         func() { ran = append(ran, "open") },
		OpenWindow:   func(url string) { ran = append(ran, url) },
		GitHub:       func() { ran = append(ran, "github") },
		Quit:         func() { ran = append(ran, "quit") },
	}
	click := func(items []Item) string {
		ran = nil
		for _, it := range items {
			if it.OnClick != nil {
				it.OnClick()
			}
		}
		return strings.Join(ran, ",")
	}
	items, _ := layout(state{transfers: "History (1 running)"}, a)
	if got := click(items); got != "open,/history,/guides,github,quit" {
		t.Errorf("the items ran %s", got)
	}
	a.Open = nil
	items, _ = layout(state{}, a)
	if got := click(items[:1]); got != "launcher" {
		t.Errorf("Open without its own action ran %s", got)
	}
}

func TestDot(t *testing.T) {
	for _, c := range []struct {
		state state
		want  bool
	}{
		{state{}, false},
		{state{running: []Item{mounts}}, false},
		{state{running: []Item{mounts, serves}}, false},
		{state{transfers: "History (1 running)"}, true},
		{state{transfers: "History (2 running · 27%)", running: []Item{mounts, serves}}, true},
	} {
		if got := c.state.dot(); got != c.want {
			t.Errorf("transfers %q, %d running items: dot %v, want %v", c.state.transfers, len(c.state.running), got, c.want)
		}
	}
}

func TestEscapeMnemonics(t *testing.T) {
	for _, c := range []struct{ label, goos, want string }{
		{"my_drive: → /mnt/my_drive", "linux", "my__drive: → /mnt/my__drive"},
		{"R&D: → R:", "windows", "R&&D: → R:"},
		{"R&D_x: → R:", "darwin", "R&D_x: → R:"},
		{"a&b_c", "linux", "a&b__c"},
	} {
		if got := escapeMnemonics(c.label, c.goos); got != c.want {
			t.Errorf("%q on %s: %q, want %q", c.label, c.goos, got, c.want)
		}
	}
}

func TestIconFiles(t *testing.T) {
	cases := []struct {
		appearance, goos string
		mint             bool
		light, dark      string
		template         bool
	}{
		{"system", "darwin", false, "icons/icon.png", "", true},
		{"system", "windows", false, "icons/icon-light.png", "icons/icon.png", false},
		{"system", "linux", true, "icons/icon-light-padded.png", "icons/icon-padded.png", false},
		{"color", "linux", true, "icons/icon-color-padded.png", "", false},
		{"color", "darwin", false, "icons/icon-color.png", "", false},
		{"dark", "windows", false, "icons/icon-light.png", "", false},
		{"light", "darwin", false, "icons/icon.png", "", true},
	}
	for _, c := range cases {
		light, dark, template := IconFiles(c.appearance, c.goos, c.mint)
		if light != c.light || dark != c.dark || template != c.template {
			t.Errorf("IconFiles(%q, %q, %v) = %q, %q, %v", c.appearance, c.goos, c.mint, light, dark, template)
		}
		for _, name := range []string{light, dark} {
			if name != "" {
				if _, err := icons.ReadFile(name); err != nil {
					t.Errorf("icon %s not embedded: %v", name, err)
				}
			}
		}
	}
}

func TestMarked(t *testing.T) {
	for _, template := range []bool{false, true} {
		src := mustIcon("icons/icon-color.png")
		got, err := Marked(src, template)
		if err != nil {
			t.Fatal(err)
		}
		before, _ := png.Decode(bytes.NewReader(src))
		img, err := png.Decode(bytes.NewReader(got))
		if err != nil {
			t.Fatal(err)
		}
		b := img.Bounds()
		if b != before.Bounds() {
			t.Fatalf("bounds %v, were %v", b, before.Bounds())
		}
		size := float64(b.Dx())
		cx, cy := int(float64(b.Max.X)-size*0.28), int(size*0.28)
		want := color.NRGBA{R: 0xff, G: 0x3b, B: 0x30, A: 0xff}
		if template {
			want = color.NRGBA{A: 0xff}
		}
		if c := color.NRGBAModel.Convert(img.At(cx, cy)).(color.NRGBA); c != want {
			t.Errorf("template %v: the dot's middle is %v", template, c)
		}
		if _, _, _, a := img.At(cx-int(size*0.24), cy).RGBA(); a != 0 {
			t.Errorf("template %v: the ring isn't clear", template)
		}
		if img.At(0, b.Max.Y-1) != before.At(0, b.Max.Y-1) || img.At(b.Dx()/3, b.Dy()*2/3) != before.At(b.Dx()/3, b.Dy()*2/3) {
			t.Errorf("template %v: the glyph changed away from the corner", template)
		}
	}
}
