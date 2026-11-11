package mounts

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

// Support reports whether this computer can mount. When it can't, it says why and links to more
// information. The Mount page shows it as a notice. On Windows, it offers to install WinFsp
// when CanInstall is set, and links to WinFsp's downloads otherwise.
type Support struct {
	Supported bool `json:"supported"`
	// Reason says why it can't. It is English inside the core, for the logs, and the API gives it
	// in the app's language.
	Reason string `json:"reason,omitempty"`
	Docs   string `json:"docs,omitempty"`
	// CanInstall is true when WinFsp is missing and its installer is next to the app, so
	// InstallWinFsp can install it.
	CanInstall bool `json:"canInstall,omitempty"`

	reason i18n.Text // Reason as a translatable text
}

func cannotMount(reason i18n.Text, docs string) Support {
	return Support{Reason: reason.String(), Docs: docs, reason: reason}
}

// localized returns s with its reason in the app's language, as a page shows it.
func (s Support) localized() Support {
	if !s.reason.IsZero() {
		s.Reason = s.reason.Local()
	}
	return s
}

// flatpakSupport is used inside a Flatpak. The sandbox has no fusermount3, and no way to mount a
// folder that the host can see.
var flatpakSupport = cannotMount(
	i18n.M("The Flatpak can't mount: install Rclone UI's deb, rpm or AppImage to mount remotes."),
	"https://github.com/rclone/rclone-ui/releases")

// WinFspInstaller is the WinFsp installer that Rclone UI's Windows installer and portable zip put
// next to rcui.exe. build/package.sh downloads it, at a pinned version.
const WinFspInstaller = "winfsp.msi"

// winFspDownloads is where to get WinFsp when the app has no installer of its own (a build that
// didn't come from build/package.sh).
const winFspDownloads = "https://github.com/winfsp/winfsp/releases"

// CheckSupport checks again on every call and never caches the result, because WinFsp or the
// FUSE device can appear while the app runs. Windows needs WinFsp and Linux needs /dev/fuse.
// macOS mounts through the system NFS client and needs neither.
func CheckSupport() Support {
	if os.Getenv("FLATPAK_ID") != "" {
		return flatpakSupport
	}
	return supportOn(runtime.GOOS, func(p string) bool {
		_, err := os.Stat(p)
		return err == nil
	}, winFspInstalled)
}

// supportOn applies the rule for one OS. exists reports whether a path exists, and winFsp whether
// WinFsp is installed. On Linux, only the device's existence is checked. A container that has the
// device but lacks SYS_ADMIN fails when it mounts, and rclone reports the error then.
func supportOn(goos string, exists func(string) bool, winFsp func() bool) Support {
	switch goos {
	case "windows":
		if winFsp() {
			return Support{Supported: true}
		}
		return cannotMount(i18n.M("WinFsp is not installed."), winFspDownloads)
	case "linux":
		if !exists("/dev/fuse") {
			return cannotMount(
				i18n.M("There is no /dev/fuse: a container needs --device /dev/fuse --cap-add SYS_ADMIN."),
				"https://rclone.org/install/#docker")
		}
	}
	return Support{Supported: true}
}

// Support reports whether this computer can mount right now. It checks again on every call.
func (s *Service) Support() Support {
	sup := s.o.support()
	sup.CanInstall = !sup.Supported && s.winFspInstaller() != ""
	return sup
}

// winFspInstaller returns the WinFsp installer next to the app, or "" when there is none.
func (s *Service) winFspInstaller() string {
	if s.o.goos != "windows" || s.o.Executable == "" {
		return ""
	}
	p := filepath.Join(filepath.Dir(s.o.Executable), WinFspInstaller)
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	return p
}

// installingWinFsp lets one install run at a time, as two windows can both ask for one.
var installingWinFsp sync.Mutex

// InstallWinFsp installs WinFsp with the installer next to the app, and returns once it is done.
// It needs administrator rights, which Windows asks the user for. The error is Canceled when the
// user says no. Afterwards mounts.changed (without an ID) tells the pages to read Support again.
// The install goes on when ctx ends, because stopping msiexec halfway would leave the driver half
// installed.
func (s *Service) InstallWinFsp(context.Context) error {
	installingWinFsp.Lock()
	defer installingWinFsp.Unlock()
	if s.o.support().Supported { // installed while this call waited for another
		return nil
	}
	msi := s.winFspInstaller()
	if msi == "" {
		return errs.Unsupported("winfsp", "Rclone UI has no WinFsp installer here. Download it from %s.", winFspDownloads)
	}
	err := installMSI(msi)
	s.changed(bus.MountsChangedData{})
	return err
}
