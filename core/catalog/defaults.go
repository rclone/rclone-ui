package catalog

import "encoding/json"

// The app's own defaults for rclone's options. rclone's own defaults are tuned for a command that
// runs once in a terminal, so the app raises the number of parallel transfers and checkers, and
// the number of streams that a large file is sent in. A mount caches writes, so that apps can save
// files on it. Everything else is rclone's own default.
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

// mountVFSDefaults are the defaults in a mount's vfs group. With rclone's own default (off), most
// apps can open the files on a mount but can't save them.
func mountVFSDefaults() Group {
	return Group{
		"vfs_cache_mode": json.RawMessage(`"writes"`),
	}
}

// Defaults returns the app's default options, keyed by operation ("copy", "mount"…) and then by
// the form's group ("config", "copy"…). An operation without defaults is left out. Copy, Move,
// Sync and Bisync keep their multi-thread default in their own group, where the pages show it.
// A save has only a config group, so its multi-thread default goes there. A mount's vfs group has
// its cache mode, and a serve's has none. Each call returns new maps, so a caller may change them.
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
		"mount":  {"config": configDefaults(), "vfs": mountVFSDefaults()},
		"serve":  {"config": configDefaults()},
	}
}
