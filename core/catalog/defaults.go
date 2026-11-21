package catalog

import "encoding/json"

// The app's own defaults for rclone's options. rclone's own defaults are tuned for a command that
// runs once in a terminal, so the app raises the number of parallel transfers and checkers, and
// the number of streams that a large file is sent in. Everything else is rclone's own default.
//
// The operations package applies them under every transfer, mount and serve (withDefaults),
// whatever starts it. The pages show them in their option groups, and send only what differs:
// a changed value, or null for a default that the user removed, which means rclone's own default.
// So a saved template, schedule or automount holds only the user's own choices.

// configDefaults are the defaults in the config group of every operation that has options.
func configDefaults() Group {
	return Group{
		"transfers": json.RawMessage(`8`),
		"checkers":  json.RawMessage(`16`),
	}
}

// multiThreadDefaults are the defaults for an operation that copies files. A large file is sent
// in this many streams at once.
func multiThreadDefaults() Group {
	return Group{
		"multi_thread_streams": json.RawMessage(`8`),
	}
}

// Defaults returns the app's default options, keyed by operation ("copy", "mount"…) and then by
// the form's group ("config", "copy"…). An operation without defaults is left out. Copy, Move,
// Sync and Bisync keep their multi-thread default in their own group, where the pages show it.
// A save has only a config group, so its multi-thread default goes there. A mount and a serve
// have none in their vfs group. Each call returns new maps, so a caller may change them.
func Defaults() map[string]map[string]Group {
	withMultiThread := func(own string) map[string]Group {
		return map[string]Group{own: multiThreadDefaults(), "config": configDefaults()}
	}
	save := configDefaults()
	for name, value := range multiThreadDefaults() {
		save[name] = value
	}
	return map[string]map[string]Group{
		"copy":   withMultiThread("copy"),
		"move":   withMultiThread("move"),
		"sync":   withMultiThread("sync"),
		"bisync": withMultiThread("bisync"),
		"save":   {"config": save},
		"delete": {"config": configDefaults()},
		"purge":  {"config": configDefaults()},
		"mount":  {"config": configDefaults()},
		"serve":  {"config": configDefaults()},
	}
}
