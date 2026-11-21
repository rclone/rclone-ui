package browse

import (
	"strings"

	"github.com/rclone/rclone/fs/fspath"
)

// Clean puts a listing's location in the form that keys its cache entry. fs is the root that is
// listed (`remote:`, `remote:/`, `:local:/`), and dir is the folder below it, without slashes at
// either end. A leading slash on dir moves to the root, so `remote:` + `/a` becomes `remote:/` +
// `a`. On sftp that is the machine's root rather than the login folder. listingKey.ts keeps the
// two apart in the same way.
func Clean(fsName, dir string) (string, string) {
	if strings.HasPrefix(dir, "/") && strings.HasSuffix(fsName, ":") {
		fsName += "/"
	}
	return fsName, strings.Trim(dir, "/")
}

func Join(fsName, dir string) string { return fspath.JoinRootPath(fsName, dir) }

// place is a parsed path, used to match listings when they are invalidated. remote is the
// config name without connection-string parameters (listingKey.ts also keys by the panel's
// remote), or ":local" for this machine. abs says whether the path is absolute. path has no
// slashes at either end and uses `/` between names, because fspath turns `\` into `/` on Windows.
type place struct {
	remote string
	abs    bool
	path   string
}

func placeOf(p string) (place, bool) {
	parsed, err := fspath.Parse(p)
	if err != nil {
		return place{}, false
	}
	name, pth := parsed.Name, parsed.Path
	if name == "" {
		name = ":local"
	}
	return place{remote: name, abs: strings.HasPrefix(pth, "/"), path: strings.Trim(pth, "/")}, true
}

// parent returns the folder that holds p. A root has nothing above it, so it is its own parent.
func (p place) parent() place {
	i := strings.LastIndexByte(p.path, '/')
	if i < 0 {
		p.path = ""
	} else {
		p.path = p.path[:i]
	}
	return p
}

// covers reports whether q is p or a folder below it (`r:ab` is not below `r:a`).
func (p place) covers(q place) bool {
	if p.remote != q.remote || p.abs != q.abs {
		return false
	}
	return p.path == "" || q.path == p.path || strings.HasPrefix(q.path, p.path+"/")
}
