package launcher

import "strings"

// waylandSession reports whether the desktop is a Wayland session, using the same rule as Wails:
// XDG_SESSION_TYPE when it is set, and otherwise whether WAYLAND_DISPLAY is set.
func waylandSession(getenv func(string) string) bool {
	switch strings.ToLower(getenv("XDG_SESSION_TYPE")) {
	case "wayland":
		return true
	case "x11":
		return false
	}
	return getenv("WAYLAND_DISPLAY") != ""
}

// portalTrigger converts a Wails accelerator ("CmdOrCtrl+Shift+/") into the preferred trigger
// for the GlobalShortcuts portal ("CTRL+SHIFT+slash"). The modifiers use the portal's names and
// order, and the key uses its XKB keysym name. The trigger is only a preference, because the
// compositor and the user decide the actual keys.
func portalTrigger(accel string) string {
	// Accelerator writes a "+" key as "plus", so every "+" is a separator.
	parts := strings.Split(accel, "+")
	key := parts[len(parts)-1]
	has := map[string]bool{}
	for _, m := range parts[:len(parts)-1] {
		switch strings.ToLower(m) {
		case "cmdorctrl", "ctrl":
			has["CTRL"] = true
		case "alt":
			has["ALT"] = true
		case "shift":
			has["SHIFT"] = true
		case "super":
			has["LOGO"] = true
		}
	}
	var out []string
	for _, m := range []string{"CTRL", "ALT", "SHIFT", "LOGO"} {
		if has[m] {
			out = append(out, m)
		}
	}
	if name, ok := keysyms[strings.ToLower(key)]; ok {
		key = name
	} else {
		key = strings.ToLower(key)
	}
	return strings.Join(append(out, key), "+")
}

// keysyms maps the keys that Accelerator writes to their XKB names, for keys whose name isn't the
// character itself.
var keysyms = map[string]string{
	";": "semicolon", "=": "equal", ",": "comma", "-": "minus", ".": "period", "/": "slash",
	"`": "grave", "[": "bracketleft", `\`: "backslash", "]": "bracketright", "'": "apostrophe",
	"+": "plus", "plus": "plus",
	"backspace": "BackSpace", "tab": "Tab", "return": "Return", "enter": "Return",
	"escape": "Escape", "space": "space", "page up": "Prior", "page down": "Next", "end": "End",
	"home": "Home", "left": "Left", "up": "Up", "right": "Right", "down": "Down",
	"delete": "Delete",
	"f1":     "F1", "f2": "F2", "f3": "F3", "f4": "F4", "f5": "F5", "f6": "F6", "f7": "F7", "f8": "F8",
	"f9": "F9", "f10": "F10", "f11": "F11", "f12": "F12", "f13": "F13", "f14": "F14", "f15": "F15",
	"f16": "F16", "f17": "F17", "f18": "F18", "f19": "F19", "f20": "F20", "f21": "F21", "f22": "F22",
	"f23": "F23", "f24": "F24",
}
