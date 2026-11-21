// Package icons holds the launcher's glyphs, which are the regular variants of Zappicon icons.
// They are SVG documents that each view draws with its OS's own renderer, so they stay sharp at
// any scale and can be tinted per row. gen (go generate) writes icons_gen.go from
// node_modules/@zappicon/react, for the names below.
package icons

import (
	"maps"
	"slices"
	"strings"
)

//go:generate go run ./gen

// Name identifies a glyph by the name of its Zappicon file.
type Name string

// The launcher's glyphs, named by what they stand for. After adding one, run go generate.
const (
	Copy       Name = "page"
	Move       Name = "arrow-right-square"
	Sync       Name = "arrows-rotate"
	Bisync     Name = "repeat"
	Download   Name = "download-bracket"
	Mount      Name = "hard-drive"
	Serve      Name = "tower-broadcast"
	Delete     Name = "trash"
	Purge      Name = "trash-simple"
	Cleanup    Name = "archive-box"
	VFS        Name = "database"
	Settings   Name = "gear"
	Commander  Name = "layout-1"
	Transfers  Name = "inbox"
	Failed     Name = "exclamation-triangle"
	Templates  Name = "layer-group"
	Watchers   Name = "folder-connection"
	Schedules  Name = "clock"
	Automounts Name = "play-circle"
	Wizard     Name = "compass"
	Guides     Name = "graduation-cap"
	NewRemote  Name = "plus"
	Remotes    Name = "server-simple"
	Bell       Name = "bell"
	Mobile     Name = "mobile"
	Remote     Name = "cloud"
	Folder     Name = "folder"
	File       Name = "file"
	GitHub     Name = "code"
	Quit       Name = "power-off"
	Stop       Name = "stop"
	StopAll    Name = "ban"
	Open       Name = "arrow-up-right-square"
	Link       Name = "link-simple"
	Back       Name = "arrow-left-small"
	Search     Name = "search"
	Edit       Name = "pen"
	Clipboard  Name = "clipboard"
	Reveal     Name = "eye"
	Browser    Name = "globe-simple"
)

// SVG returns the glyph's document (24×24, black, to be tinted), or "" for an unknown name.
func SVG(n Name) string { return svgs[n] }

// All returns every glyph's name, sorted.
func All() []Name { return slices.Sorted(maps.Keys(svgs)) }

// Tinted returns the glyph's document in a colour (#rrggbb), for the views that can't tint a
// black image themselves. It returns "" for an unknown name.
func Tinted(n Name, colour string) string {
	return strings.ReplaceAll(svgs[n], `"#000"`, `"`+colour+`"`)
}
