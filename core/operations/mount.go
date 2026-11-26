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

type MountEnv struct {
	OS        string
	Exe       string
	CacheRoot string
	// The config file is part of the cache folder's name, because rclone keys a cache by the
	// remote's name alone. Two config files may each have a gdrive remote, and without this, one
	// account's queued uploads could go to the other.
	Config  string
	NFSPort int
}

const PlaceholderNFSPort = 1

const MountPointArg = 2

type Mount struct {
	Args       []string
	Source     string
	MountPoint string
	CacheDir   string
	Flags      []string
	own        []blockGroup
	groups     Groups
}

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
	sum := sha256.Sum256([]byte(env.Config + "\x00" + a.Source + "\x00" + mountPoint))
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

func mountPointOf(destination string) (mountPoint string, drive bool, err error) {
	// A drive letter alone means the drive that the mount becomes. In any other path, it would
	// mean the folder last used on that drive.
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
	root := at.Anchor
	vol := filepath.VolumeName(root)
	if vol != "" {
		root = vol + "/"
	}
	if at.Rel != "" {
		return root + path.Clean(at.Rel), false, nil
	}
	if vol != "" {
		return vol, true, nil
	}
	return root, false, nil
}

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
