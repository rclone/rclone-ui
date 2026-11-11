package operations

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"strings"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
)

// MountEnv holds what a mount's command line needs in addition to the page's form.
type MountEnv struct {
	// OS is a GOOS value, which decides the mount command. The paths are still parsed the way
	// rclone parses them on the OS that this build targets (core/location).
	OS  string
	Exe string // the running executable, for the app's own metadata mapper
	// CacheRoot is rclone's cache folder, <data>/cache. Each mount's VFS cache is a stable folder
	// under it. When a mount stops with uploads still queued, the next mount of the same source,
	// at the same mount point and with the same config file, sends them.
	CacheRoot string
	// Config is the config file that the mount uses. It is also part of the cache folder's name,
	// because rclone keys a cache by the remote's name alone. Two config files may each have a
	// gdrive remote, and without this, one account's queued uploads could go to the other.
	Config  string
	NFSPort int // on macOS, the free port that nfsmount serves on, picked by the parent
}

// Mount is the command line of a mount child, and the details that the parent keeps about it.
type Mount struct {
	// Args come after the child entry: `nfsmount|mount|cmount <fs> <mount point> --flag=value…`.
	// The parent adds the flags that every child gets.
	Args       []string
	Source     string // the mounted Fs, with the overrides included
	MountPoint string // `*` on Windows when rclone picks the drive
	CacheDir   string
	// Flags are the flags from the page's groups, which Args ends with. A script's mount
	// (MountScript) has only these, without the NFS port and the cache folder that the app picks.
	Flags []string
	// own holds the mount and vfs groups that Flags were made from, and groups holds the form's
	// groups with the app's defaults, for a program's mount (sdkMount).
	own    []blockGroup
	groups Groups
}

// MountCommand builds a mount's command line as a child's arguments. It uses `nfsmount` on macOS,
// served on 127.0.0.1 at env.NFSPort, `mount` on Linux and `cmount` on Windows. The mount, vfs,
// config, metadata and filter groups become flags, with the app's defaults under them
// (withDefaults), and the cache goes in the mount's stable folder.
func MountCommand(a MountArgs, env MountEnv) (Mount, error) {
	a.Options = withDefaults(OperationMount, a.Options)
	windows := env.OS == "windows"
	if a.Source == "" || a.Destination == "" {
		return Mount{}, errs.New("Destination and source are required")
	}
	if err := location.Refusal(a.Source); err != nil {
		return Mount{}, err
	}
	wildcard := windows && a.Destination == "*"
	mountPoint, drive := "*", false
	if !wildcard {
		var err error
		if mountPoint, drive, err = mountPointOf(a.Destination); err != nil {
			return Mount{}, err
		}
	}
	remotes, err := a.Options.remotes()
	if err != nil {
		return Mount{}, err
	}
	// Only the syntax is checked here. The child reads the remote from its own config file,
	// which may not be the one loaded in this process (see checkOverrides).
	src := split(a.Source)
	source, err := fsString(src, src.Dir(), remotes[src.Name])
	if err != nil {
		return Mount{}, err
	}
	mountOptions, err := decodeGroup(GroupMount, a.Options.Mount)
	if err != nil {
		return Mount{}, err
	}
	vfsOptions, err := decodeGroup(GroupVFS, a.Options.VFS)
	if err != nil {
		return Mount{}, err
	}
	// The hash leaves out the drive picked for a `*` and the mount's id. Either would change
	// when the mount starts again, and the mount would lose its cache folder and the uploads
	// waiting in it.
	sum := sha256.Sum256([]byte(env.Config + "\x00" + a.Source + "\x00" + mountPoint))
	// macOS gives every mount a volume name. Windows gives one only to a folder mount, because a
	// drive has a label instead.
	needsVolumeName := env.OS == "darwin" || windows && !wildcard && !drive
	if needsVolumeName && isBlank(mountOptions["volname"]) {
		mountOptions["volname"] = volumeName(a.Source, sum[0])
	}

	var command string
	var args []string
	switch env.OS {
	case "darwin":
		if env.NFSPort <= 0 {
			return Mount{}, errors.New("no port for the NFS mount")
		}
		command = "nfsmount"
		args = append(args, fmt.Sprintf("--addr=127.0.0.1:%d", env.NFSPort))
	case "windows":
		command = "cmount"
	default:
		command = "mount"
	}
	cacheDir := filepath.Join(env.CacheRoot, "vfs", hex.EncodeToString(sum[:8]))
	args = append(args, "--cache-dir="+cacheDir)
	own := []blockGroup{
		{GroupMount, mountOptions, []string{GroupMount}},
		{GroupVFS, vfsOptions, []string{GroupVFS}},
	}
	flags, err := commandFlags(a.Options, env.Exe, own...)
	if err != nil {
		return Mount{}, err
	}
	return Mount{
		Args:       append([]string{command, source, mountPoint}, append(args, flags...)...),
		Source:     source,
		MountPoint: mountPoint,
		CacheDir:   cacheDir,
		Flags:      flags,
		own:        own,
		groups:     a.Options,
	}, nil
}

// mountPointOf returns the mount point as a local path on this machine. The backend name is
// removed from its root, and the path is cleaned. drive reports whether the mount point is a
// whole drive (`X:`), which has a label rather than a volume name.
func mountPointOf(destination string) (mountPoint string, drive bool, err error) {
	// A drive letter alone means the drive that the mount becomes. In any other path, it would
	// mean the folder last used on that drive, which is why Problem refuses it there.
	if vol := filepath.VolumeName(destination); len(vol) == 2 && vol == destination {
		return vol, true, nil
	}
	if err := location.Refusal(destination); err != nil {
		return "", false, err
	}
	at := split(destination)
	if at.Name != ":local" || len(at.Params) > 0 {
		return "", false, errs.New("The mount point must be a folder on this computer")
	}
	// Only Windows paths have a volume name. It is written as filepath writes it, because rclone
	// reads a share as one only in the machine's own form (`\\server\share`).
	root := at.Anchor
	vol := filepath.VolumeName(root)
	if vol != "" {
		root = vol + "/"
	}
	if at.Rel != "" {
		return root + path.Clean(at.Rel), false, nil
	}
	// For a root, a drive or a share is named without its slash.
	if vol != "" {
		return vol, true, nil
	}
	return root, false, nil
}

// volumeName returns the name shown for a mount's volume. It is the last segment of the source,
// followed by one character that tells two mounts of it apart. The character comes from the
// mount's hash rather than being random, so it stays the same across restarts.
func volumeName(source string, b byte) string {
	segments := strings.FieldsFunc(source, func(r rune) bool { return r == '/' || r == '\\' })
	name := ""
	switch len(segments) {
	case 0:
	case 1:
		name = strings.ReplaceAll(segments[0], ":", "")
	default:
		name = segments[len(segments)-1]
	}
	const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	return name + "-" + string(digits[int(b)%len(digits)])
}
