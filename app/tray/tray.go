// Package tray is the app's tray icon and menu. The tray is created before anything else boots,
// so a failed boot still leaves a way to quit. The UI sets the running mounts and serves with
// SetRunning, and the transfers' progress with SetTransfers. Pages don't add anything to the tray.
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
	Label string
	// Separator draws a line instead of an item.
	Separator bool
	Disabled  bool
	// Children make the item a submenu.
	Children []Item
	// OnClick runs when the item is chosen. It is called directly from the menu's click handler,
	// so it must not block.
	OnClick func()
}

// Actions holds what the built-in items do.
type Actions struct {
	// ShowLauncher runs on a left click, on systems where a left click opens the launcher.
	ShowLauncher func()
	// Open runs for the menu's Open item. It shows the launcher, with a tip about its shortcut the
	// first time. ShowLauncher is used when it is nil.
	Open func()
	// OpenWindow opens the window for a route. The route decides the window's name and shape.
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

	// icon serialises setting the icon, so the last icon set always matches the latest state.
	icon sync.Mutex

	// rebuild serialises menu rebuilds, so that cur is always the menu shown and only the menu
	// it replaced is destroyed. curHistory is cur's History item, or nil when cur has none.
	rebuild    sync.Mutex
	cur        *application.Menu
	curHistory *application.MenuItem
}

type state struct {
	// transfers is the History item's label while transfers run, such as
	// "History (2 running · 42%)". It is "" when none runs.
	transfers string
	// running are the Mounts and Serves submenus that the UI adds, while any of them run.
	running []Item
}

// dot reports whether the icon shows a dot in its corner. It does while transfers run, and
// running mounts and serves don't show it.
func (s state) dot() bool { return s.transfers != "" }

// layout returns the menu's items for a state. Open comes first. Then History (while transfers
// run) and the Mounts and Serves submenus (while any run) share a section, which is left out with
// its separator when none of them shows. Guide, GitHub and Quit come last. history is the index
// of the History item, or -1 when it isn't shown.
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

// DefaultAppearance returns the default tray theme. On Linux it is the coloured icon, because
// panels vary too much for a monochrome one. Elsewhere it follows the system.
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
	t.st.SetTooltip("Rclone UI")
	t.applyIcon()
	t.cur, t.curHistory = t.menu()
	t.st.SetMenu(t.cur)
	switch runtime.GOOS {
	case "darwin":
		// Both clicks open the menu, which is Wails' default on macOS when there is no click
		// handler.
	case "windows":
		// Both buttons open the menu. Wails opens it on a right click by default, and the left
		// click is set here. The launcher is opened from the menu's Open item.
		t.st.OnClick(t.st.OpenMenu)
	default:
		t.st.OnClick(func() { actions.ShowLauncher() })
	}
	return t
}

// SetRunning replaces the items that the UI adds, which are the Mounts and Serves submenus.
func (t *Tray) SetRunning(items []Item) {
	t.mu.Lock()
	t.state.running = items
	t.mu.Unlock()
	t.setMenu()
}

// destroyGrace is how long a replaced menu is kept before it is destroyed. It may still be open,
// or a click on it may still be on its way, and the items of a destroyed menu no longer run.
const destroyGrace = time.Minute

// setMenu shows a menu built from the latest state. It destroys the replaced menu on the main
// thread once destroyGrace has passed, because Wails keeps every item (and its closure) until its
// menu is destroyed.
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

// SetTransfers sets the History item's label, such as "History (2 running · 42%)", or "" when no
// transfer runs. When the first transfer starts or the last one ends, the menu is rebuilt and the
// icon is changed. Both happen in the background, because they wait for the main thread, and the
// caller may hold a lock that the main thread needs. While transfers keep running, the label is
// changed in place. It changes every second, and a menu replaced that often would close under the
// pointer, because Windows destroys the menu that was replaced.
func (t *Tray) SetTransfers(label string) {
	// Hold rebuild, so that a menu being built either picks up this label or is relabelled here.
	t.rebuild.Lock()
	defer t.rebuild.Unlock()
	t.mu.Lock()
	prev := t.state.transfers
	t.state.transfers = label
	t.mu.Unlock()
	switch {
	case label == prev:
	case (label == "") != (prev == ""):
		// A rebuild reads the state when it runs, so the last one shows the latest label.
		go t.setMenu()
		go t.applyIcon()
	case t.curHistory != nil:
		item := t.curHistory
		application.InvokeAsync(func() { item.SetLabel(escapeMnemonics(label, runtime.GOOS)) })
	}
}

// Rebuild builds the menu again from the latest state. The app calls it when the language
// changes, because the menu's own labels are translated when it is built.
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

// Marked returns a tray icon (a PNG) with the dot that shows while transfers run. The dot is in the
// top right corner, separated from the glyph by a transparent ring. The dot is red, or opaque black
// for a template icon, because macOS tints a template the same way as the glyph, so only its
// shape shows.
func Marked(icon []byte, template bool) ([]byte, error) {
	src, err := png.Decode(bytes.NewReader(icon))
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	img := image.NewNRGBA(b)
	draw.Draw(img, b, src, b.Min, draw.Src)
	size := float64(min(b.Dx(), b.Dy()))
	r, ring := size*0.2, size*0.28 // the dot's radius, and the ring's outer one
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
		panic(err) // the icons are embedded above, so this can't fail
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
		panic(err) // the names refer to the icons embedded above, so this can't fail
	}
	return b
}

// menu builds the menu from the latest state, and returns it along with its History item (nil
// when it has none).
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

// addItem adds an item to a menu. It returns the added item, or nil for a separator or a submenu.
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

// escapeMnemonics keeps a label, such as a mount point or an address, as it is. Menus on Linux
// read "_" as an access key, and menus on Windows read "&", and they hide it.
func escapeMnemonics(label, goos string) string {
	switch goos {
	case "linux":
		return strings.ReplaceAll(label, "_", "__")
	case "windows":
		return strings.ReplaceAll(label, "&", "&&")
	}
	return label
}
