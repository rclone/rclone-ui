// Package location parses path strings the same way rclone does (fs/fspath), for the OS the app
// is built for. rclone runs in this process, so these paths belong to this OS. fspath defines the
// syntax, and this package only adds what fspath leaves to its callers:
//   - Problem describes what is wrong with a path, in a sentence the pages can show next to the
//     field. It quotes rclone's own words, and also catches paths that rclone accepts but reads
//     differently than the user meant: a drive path on an OS without drives, and a local path
//     that isn't absolute, which rclone reads from the app's working directory. Refusal and
//     FieldRefusal give the same sentence as an error.
//   - Split divides a path into the Fs that rclone opens and the rest below it, and gives a local
//     path an explicit root. Fs.Entry then writes an entry below that root in the same form the
//     original path used for its root. fspath.SplitFs differs: it keeps the leading slash with
//     the rest (`sftp:` + `/var`), and leaves a local path's root empty, which rclone reads
//     relative to the working directory.
//
// The frontend has its own parser (lib/paths.ts) for what it shows without asking the core.
// testdata/paths_cases.json checks that parser against fspath.
package location

import (
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/fspath"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

// The sentences that Problem, Refusal and FieldRefusal give.
const (
	unreadable   = "Rclone cannot read this path: %s."
	notWindows   = "This host is not Windows, so %[1]s: would be read as a remote called %[1]s. Use a path that starts with /."
	notFull      = "This is not a full path. Use one that starts with /."
	notFullDrive = `This is not a full path. Use one that starts with a drive, as in C:\.`
)

// problem is why a path can't be used: one of the sentences above, and its value.
type problem struct {
	format string
	arg    any
}

// problemOf finds why a typed path can't be used as it is, and returns the zero problem when it
// can. It reports rclone's reason when rclone refuses the path. It also reports paths that rclone
// accepts but reads differently than the user meant:
//   - A Windows drive path on an OS without drives, which rclone reads as a remote named after
//     the letter.
//   - A local path that isn't absolute (`tmp`, `./x`, `~/x`, `:local:x`), which rclone reads from
//     the app's working directory, wherever that is.
//   - A drive with no separator after it (`C:` or `C:x`), which Windows reads from the folder
//     last used on that drive. The same applies to a drive in a path on a remote of type local.
//
// An empty path has no problem, because the pages ask for a missing path themselves.
func problemOf(p string) problem {
	if p == "" {
		return problem{}
	}
	parsed, err := fspath.Parse(p)
	if err != nil {
		return problem{unreadable, err}
	}
	if runtime.GOOS != "windows" && isLetter(parsed.Name) && parsed.Path != "" &&
		(parsed.Path[0] == '/' || parsed.Path[0] == '\\') {
		return problem{notWindows, parsed.Name}
	}
	local := parsed.Name == "" || parsed.Name == ":local"
	if local && !full(parsed.Path) || !local && driveRelative(parsed.Path) && localBackend(parsed.Name, parsed.Config) {
		if runtime.GOOS == "windows" {
			return problem{format: notFullDrive}
		}
		return problem{format: notFull}
	}
	return problem{}
}

// Problem says why a typed path can't be used as it is (see problemOf), in a sentence that is
// translated when it is shown. It returns the zero Text when the path can be used.
func Problem(p string) i18n.Text {
	switch pr := problemOf(p); pr.format {
	case unreadable:
		// i18n: rclone's own reason follows, in English.
		return i18n.M(unreadable, pr.arg)
	case notWindows:
		// i18n: The value is a single letter, such as C, which Windows uses for a drive.
		return i18n.M(notWindows, pr.arg)
	case notFull:
		return i18n.M(notFull)
	case notFullDrive:
		return i18n.M(notFullDrive)
	}
	return i18n.Text{}
}

// Refusal returns Problem's sentence as a refusal of the request, or nil when the path can be
// used.
func Refusal(p string) error {
	if problem := Problem(p); !problem.IsZero() {
		return errs.Sentence(problem)
	}
	return nil
}

// FieldRefusal returns Problem's sentence as a refusal of field's value, or nil when the path can
// be used.
func FieldRefusal(field, p string) error {
	if problem := Problem(p); !problem.IsZero() {
		return errs.FieldText(field, problem)
	}
	return nil
}

// full reports whether a local path points to the same place whatever the working directory.
// That is true for an absolute path, a path from the root of a drive or a share, and on Windows a
// path from the root of the current drive (fspath has already turned `\` into `/` there).
func full(p string) bool {
	if driveRelative(p) {
		return false
	}
	return filepath.IsAbs(p) || filepath.VolumeName(p) != "" || strings.HasPrefix(p, "/")
}

// driveRelative reports whether a local path starts with a drive with no separator after it
// (`C:`, `C:x`). Windows reads such a path from the folder last used on that drive, not from the
// drive's root. It is only ever true on Windows, because no other OS has drives.
func driveRelative(p string) bool {
	vol := filepath.VolumeName(p)
	return len(vol) == 2 && vol[1] == ':' && (len(p) == 2 || p[2] != '/' && p[2] != '\\')
}

// localBackend reports whether a remote uses the local backend. That is `:local`, or a remote in
// the config whose type is local (`mylocal:C:\x`). Paths on such remotes have drives and shares,
// like the machine's own paths.
func localBackend(name string, params configmap.Simple) bool {
	if name == ":local" {
		return true
	}
	if name == "" || strings.HasPrefix(name, ":") {
		return false
	}
	// Look up the type the way rclone finds the backend (fs.ParseRemote): first the path's
	// parameters, then the config.
	typ, _ := fs.ConfigMap("", nil, name, params).Get("type")
	return typ == "local"
}

// isLetter reports whether name is a single ASCII letter, which is a drive on Windows. It doesn't
// use fs/driveletter, because that returns false on every other OS and so can't catch the
// mistake there.
func isLetter(name string) bool {
	return len(name) == 1 && (name[0] >= 'a' && name[0] <= 'z' || name[0] >= 'A' && name[0] <= 'Z')
}

// Fs is a path split the way rclone opens it: the Fs of its root, and the rest below that root.
type Fs struct {
	// Name is the remote's name in the config (`gdrive`, `:sftp`), or `:local` for a local path.
	Name string
	// Config is the config string that rclone reads the remote from, with the parameters as the
	// path wrote them (`gdrive,chunk_size="8M"`). It is `:local` for a local path.
	Config string
	// Params are those parameters as rclone parsed them, or nil when there are none.
	Params configmap.Simple
	// Anchor is what comes between the colon and the rest. It can be empty (`gdrive:`), the
	// slash the path had (`sftp:/`, which is the machine's root rather than the login folder), or
	// a local path's volume and slash (`/`, `C:/`, `//server/share/`). It is never empty for a
	// local path, because a bare `:local:` means the app's working directory.
	Anchor string
	// Rel is the rest of the path, without separators at either end, and with `/` between
	// names as rclone's remotes use.
	Rel string
	// Folder is true when the path is written as a folder: a root, or a trailing separator.
	Folder bool
	// Local is true for a plain path on this machine (`/tmp`, `C:\x`). `:local:/tmp` points to
	// the same folder but is written as a remote, so Local is false and Entry keeps that form.
	Local bool
}

// Split parses p the way rclone does (fspath.Parse, which turns `\` into `/` on Windows only) and
// splits it into its root and the rest. It returns rclone's error for a path rclone refuses.
func Split(p string) (Fs, error) {
	parsed, err := fspath.Parse(p)
	if err != nil {
		return Fs{}, err
	}
	at := Fs{Name: parsed.Name, Config: parsed.ConfigString, Params: parsed.Config}
	rest := parsed.Path
	if at.Name == "" {
		at.Name, at.Config, at.Local = ":local", ":local", true
	}
	// A drive or a share is the root of a path on the local backend, including a named remote
	// of type local. This only happens on Windows. On any other remote, `//` is just two
	// slashes. The volume is cut from rest, because filepath.VolumeName writes a share with `\`
	// (`\\server\share`) and the anchor keeps rclone's `/`.
	if vol := len(filepath.VolumeName(rest)); vol > 0 && localBackend(at.Name, at.Params) {
		at.Anchor, rest = rest[:vol], rest[vol:]
	}
	if at.Local || strings.HasPrefix(rest, "/") {
		at.Anchor += "/"
	}
	at.Rel = strings.Trim(rest, "/")
	at.Folder = at.Rel == "" || strings.HasSuffix(rest, "/")
	return at, nil
}

// Root returns the Fs that rclone opens for the path's root: the config string, a colon and the
// anchor (`gdrive:`, `sftp:/`, `:local:/`, `:local:C:/`).
func (f Fs) Root() string { return f.Config + ":" + f.Anchor }

// Dir returns Rel as a folder below the root, with a trailing slash. It returns "" for the root
// itself.
func (f Fs) Dir() string {
	if f.Rel == "" {
		return ""
	}
	return f.Rel + "/"
}

// Path returns Rel as the original path wrote it, with a trailing slash for a folder.
func (f Fs) Path() string {
	if f.Folder {
		return f.Dir()
	}
	return f.Rel
}

// Base returns the last name in Rel, or "" for the root.
func (f Fs) Base() string {
	_, leaf := path.Split(f.Rel)
	return leaf
}

// Entry returns the full path of the entry at rel below f's root. rel is in the form rclone's
// listings use, with `/` between names. The result keeps the form of the path f was parsed
// from. A remote keeps its root as is (`gdrive:`, `sftp:/`, `:local:/`). A local path uses the
// machine's own form, with its separator throughout (`/tmp/x`, `C:\x`).
func (f Fs) Entry(rel string) string {
	if !f.Local {
		return f.Root() + rel
	}
	return filepath.FromSlash(f.Anchor + rel)
}

// RenameRemote rewrites p to name the remote to instead of from, as rclone reads p.
// Connection-string parameters stay ("from,opt=x:dir" becomes "to,opt=x:dir"). It reports false,
// and returns p unchanged, for local paths, other remotes, ":from:" backends, and paths rclone
// refuses.
func RenameRemote(p, from, to string) (string, bool) {
	if from == "" {
		return p, false
	}
	parsed, err := fspath.Parse(p)
	if err != nil || parsed.Name != from || !strings.HasPrefix(p, from) {
		return p, false
	}
	return to + p[len(from):], true
}

// NotRewrittenError is returned by a remote rename's follower (remotes.Follower) for the
// saved items that it couldn't rewrite for the new name, each as an error that says
// "<what>: <why>". The rename still goes ahead, and its result lists these items.
type NotRewrittenError struct{ Items []error }

func (e *NotRewrittenError) Error() string {
	items := make([]string, len(e.Items))
	for i, it := range e.Items {
		items[i] = it.Error()
	}
	return "not rewritten: " + strings.Join(items, "; ")
}
