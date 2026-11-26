package catalog

import "encoding/json"

func configDefaults() Group {
	return Group{
		"transfers": json.RawMessage(`8`),
		"checkers":  json.RawMessage(`16`),
	}
}

func multiThreadDefaults() Group {
	return Group{
		"multi_thread_streams": json.RawMessage(`8`),
	}
}

// With rclone's own default (off), most apps can open the files on a mount but can't save them.
func mountVFSDefaults() Group {
	return Group{
		"vfs_cache_mode": json.RawMessage(`"writes"`),
	}
}

// Defaults returns the app's default options, keyed by operation ("copy", "mount"…) and then by
// the form's group ("config", "copy"…). An operation without defaults is left out. Each call
// returns new maps, so a caller may change them.
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
