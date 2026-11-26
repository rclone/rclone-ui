package icons

import (
	"maps"
	"slices"
	"strings"
)

//go:generate go run ./gen

// Name identifies a glyph by the name of its Zappicon file.
type Name string

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

func SVG(n Name) string { return svgs[n] }

func All() []Name { return slices.Sorted(maps.Keys(svgs)) }

func Tinted(n Name, colour string) string {
	return strings.ReplaceAll(svgs[n], `"#000"`, `"`+colour+`"`)
}
