package tray

import (
	"bytes"
	"embed"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/rclone/rclone-ui/core/i18n"
)

//go:embed icons/*.png
var icons embed.FS

type Item struct {
	Label     string
	Separator bool
	Disabled  bool
	Children  []Item
	// OnClick is called from the menu's click handler, so it must not block.
	OnClick func()
}

type Actions struct {
	ShowLauncher func()
	// Open runs for the menu's Open item. ShowLauncher is used when it is nil.
	Open       func()
	OpenWindow func(url string)
	GitHub     func()
	Quit       func()
}

type Tray struct {
	app     *application.App
	st      *application.SystemTray
	actions Actions
	mint    bool

	mu         sync.Mutex
	state      state
	appearance string

	icon sync.Mutex

	rebuild    sync.Mutex
	cur        *application.Menu
	curHistory *application.MenuItem
}

type state struct {
	transfers string
	running   []Item
}

func (s state) dot() bool { return s.transfers != "" }

func layout(s state, a Actions) (items []Item, history int) {
	open := Item{Label: i18n.T("Open"), OnClick: func() {
		if a.Open != nil {
			a.Open()
			return
		}
		a.ShowLauncher()
	}}
	items = []Item{open, {Separator: true}}
	section := len(items)
	history = -1
	if s.transfers != "" {
		history = len(items)
		items = append(items, Item{Label: s.transfers, OnClick: func() { a.OpenWindow("/history") }})
	}
	items = append(items, s.running...)
	if len(items) > section {
		items = append(items, Item{Separator: true})
	}
	items = append(items,
		Item{Label: i18n.T("Guide"), OnClick: func() { a.OpenWindow("/guides") }},
		Item{Label: "GitHub", OnClick: a.GitHub},
		Item{Label: i18n.T("Quit"), OnClick: a.Quit},
	)
	return items, history
}

func DefaultAppearance() string {
	if runtime.GOOS == "linux" {
		return "color"
	}
	return "system"
}

// New creates the tray icon and its menu. linuxMint pads the icons for Mint's panel.
func New(app *application.App, actions Actions, linuxMint bool) *Tray {
	t := &Tray{app: app, actions: actions, mint: linuxMint, appearance: DefaultAppearance()}
	t.st = app.SystemTray.New()
	if runtime.GOOS == "linux" {
		// On Linux, panels show the label as the first line of the tooltip. Wails names an item without
		// a label "Wails". The tooltip's text would be a second line that repeats the name.
		t.st.SetLabel("Rclone UI")
	} else {
		t.st.SetTooltip("Rclone UI")
	}
	t.applyIcon()
	t.cur, t.curHistory = t.menu()
	t.st.SetMenu(t.cur)
	switch runtime.GOOS {
	case "darwin":
		// Both clicks open the menu, which is Wails' default on macOS when there is no click
		// handler.
	case "windows":
		// Wails opens the menu on a right click by default.
		t.st.OnClick(t.st.OpenMenu)
	default:
		t.st.OnClick(func() { actions.ShowLauncher() })
	}
	return t
}

func (t *Tray) SetRunning(items []Item) {
	t.mu.Lock()
	t.state.running = items
	t.mu.Unlock()
	t.setMenu()
}

// A replaced menu may still be open, or a click on it may still be on its way, and the items of
// a destroyed menu no longer run.
const destroyGrace = time.Minute

// Wails keeps every item (and its closure) until its menu is destroyed.
func (t *Tray) setMenu() {
	t.rebuild.Lock()
	defer t.rebuild.Unlock()
	m, history := t.menu()
	t.st.SetMenu(m)
	old := t.cur
	t.cur, t.curHistory = m, history
	if old != nil {
		time.AfterFunc(destroyGrace, func() { application.InvokeAsync(old.Destroy) })
	}
}

// The menu and the icon wait for the main thread, and the caller may hold a lock that the main
// thread needs. While transfers keep running, the label changes in place, because Windows
// destroys a replaced menu, which would close it under the pointer every second.
func (t *Tray) SetTransfers(label string) {
	t.rebuild.Lock()
	defer t.rebuild.Unlock()
	t.mu.Lock()
	prev := t.state.transfers
	t.state.transfers = label
	t.mu.Unlock()
	switch {
	case label == prev:
	case (label == "") != (prev == ""):
		go t.setMenu()
		go t.applyIcon()
	case t.curHistory != nil:
		item := t.curHistory
		application.InvokeAsync(func() { item.SetLabel(escapeMnemonics(label, runtime.GOOS)) })
	}
}

func (t *Tray) Rebuild() { t.setMenu() }

// SetAppearance chooses the icon: "system", "color", "dark" or "light".
func (t *Tray) SetAppearance(appearance string) {
	t.mu.Lock()
	t.appearance = appearance
	t.mu.Unlock()
	t.applyIcon()
}

func (t *Tray) applyIcon() {
	t.icon.Lock()
	defer t.icon.Unlock()
	t.mu.Lock()
	appearance, dot := t.appearance, t.state.dot()
	t.mu.Unlock()
	light, dark, template := IconFiles(appearance, runtime.GOOS, t.mint)
	icon := func(name string) []byte {
		b := mustIcon(name)
		if dot {
			b = mustMark(b, template)
		}
		return b
	}
	if template {
		t.st.SetTemplateIcon(icon(light))
		return
	}
	t.st.SetIcon(icon(light))
	if dark != "" {
		t.st.SetDarkModeIcon(icon(dark))
	} else {
		t.st.SetDarkModeIcon(icon(light))
	}
}

// The dot is red, or opaque black for a template icon, because macOS tints a template the same
// way as the glyph.
func Marked(icon []byte, template bool) ([]byte, error) {
	src, err := png.Decode(bytes.NewReader(icon))
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	img := image.NewNRGBA(b)
	draw.Draw(img, b, src, b.Min, draw.Src)
	size := float64(min(b.Dx(), b.Dy()))
	r, ring := size*0.2, size*0.28
	cx, cy := float64(b.Max.X)-ring, float64(b.Min.Y)+ring
	dot := color.NRGBA{R: 0xff, G: 0x3b, B: 0x30, A: 0xff}
	if template {
		dot = color.NRGBA{A: 0xff}
	}
	clamp := func(v float64) float64 { return math.Max(0, math.Min(1, v)) }
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
			switch {
			case d < r+0.5:
				c := dot
				c.A = uint8(255 * clamp(r+0.5-d))
				img.SetNRGBA(x, y, c)
			case d < ring+0.5:
				c := img.NRGBAAt(x, y)
				c.A = uint8(float64(c.A) * clamp(d-(ring-0.5)))
				img.SetNRGBA(x, y, c)
			}
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func mustMark(icon []byte, template bool) []byte {
	b, err := Marked(icon, template)
	if err != nil {
		panic(err)
	}
	return b
}

// IconFiles chooses the icon files for an appearance. It returns the icon for a light panel, the
// icon for a dark panel ("" when it is the same), and whether macOS draws it as a template
// (tinted to match the menu bar).
func IconFiles(appearance, goos string, mint bool) (light, dark string, template bool) {
	suffix := ""
	if mint {
		suffix = "-padded"
	}
	name := func(base string) string { return "icons/" + base + suffix + ".png" }
	switch appearance {
	case "color":
		return name("icon-color"), "", false
	case "dark":
		return name("icon-light"), "", goos == "darwin"
	case "light":
		return name("icon"), "", goos == "darwin"
	}
	if goos == "darwin" {
		return "icons/icon.png", "", true
	}
	return name("icon-light"), name("icon"), false
}

func mustIcon(name string) []byte {
	b, err := icons.ReadFile(name)
	if err != nil {
		panic(err)
	}
	return b
}

func (t *Tray) menu() (*application.Menu, *application.MenuItem) {
	t.mu.Lock()
	s := t.state
	t.mu.Unlock()
	items, history := layout(s, t.actions)
	m := application.NewMenu()
	var historyItem *application.MenuItem
	for i, it := range items {
		if added := addItem(m, it); i == history {
			historyItem = added
		}
	}
	return m, historyItem
}

func addItem(m *application.Menu, it Item) *application.MenuItem {
	label := escapeMnemonics(it.Label, runtime.GOOS)
	switch {
	case it.Separator:
		m.AddSeparator()
	case len(it.Children) > 0:
		sub := m.AddSubmenu(label)
		for _, child := range it.Children {
			addItem(sub, child)
		}
	default:
		click := it.OnClick
		return m.Add(label).SetEnabled(!it.Disabled).OnClick(func(*application.Context) {
			if click != nil {
				click()
			}
		})
	}
	return nil
}

// Menus on Linux read "_" as an access key, and menus on Windows read "&", and they hide it.
func escapeMnemonics(label, goos string) string {
	switch goos {
	case "linux":
		return strings.ReplaceAll(label, "_", "__")
	case "windows":
		return strings.ReplaceAll(label, "&", "&&")
	}
	return label
}
