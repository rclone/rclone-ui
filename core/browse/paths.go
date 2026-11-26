package browse

import (
	"strings"

	"github.com/rclone/rclone/fs/fspath"
)

func Clean(fsName, dir string) (string, string) {
	if strings.HasPrefix(dir, "/") && strings.HasSuffix(fsName, ":") {
		fsName += "/"
	}
	return fsName, strings.Trim(dir, "/")
}

func Join(fsName, dir string) string { return fspath.JoinRootPath(fsName, dir) }

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

func (p place) parent() place {
	i := strings.LastIndexByte(p.path, '/')
	if i < 0 {
		p.path = ""
	} else {
		p.path = p.path[:i]
	}
	return p
}

func (p place) covers(q place) bool {
	if p.remote != q.remote || p.abs != q.abs {
		return false
	}
	return p.path == "" || q.path == p.path || strings.HasPrefix(q.path, p.path+"/")
}
