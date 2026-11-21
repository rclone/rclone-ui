package update

import "runtime"

// InstallType is how a copy of Rclone UI was installed, which decides how it is replaced.
type InstallType string

const (
	TypeApp       InstallType = "app"       // macOS: an .app bundle, swapped as a whole
	TypeNSIS      InstallType = "nsis"      // Windows: the NSIS installer, which is run again
	TypeAppImage  InstallType = "appimage"  // Linux: $APPIMAGE, which is replaced
	TypeDeb       InstallType = "deb"       // Linux: the deb package, through dpkg
	TypeRPM       InstallType = "rpm"       // Linux: the rpm package, through rpm
	TypeFlatpak   InstallType = "flatpak"   // updated by the software manager
	TypePortable  InstallType = "portable"  // Windows: the portable zip, updated by hand
	TypeUnmanaged InstallType = "unmanaged" // a build that no installer placed (dev, a copied binary)
)

// uninstallKey is the NSIS installer's uninstall entry (UNINSTKEY in
// build/windows/nsis/project.nsi), which detectInstall reads on Windows. It is under HKCU for a
// per-user install and under HKLM for a per-machine one.
const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\org.rclone.ui`

type Kind string

// The artifact kinds, named after the suffixes of the feed's platform keys.
const (
	KindApp      Kind = "app"      // the .app.tar.gz
	KindNSIS     Kind = "nsis"     // the -setup.exe
	KindAppImage Kind = "appimage" // the .AppImage
	KindDeb      Kind = "deb"
	KindRPM      Kind = "rpm"
)

// kind returns the artifact kind that an install of this type updates from, or "" when it doesn't
// update itself.
func (t InstallType) kind() Kind {
	switch t {
	case TypeApp:
		return KindApp
	case TypeNSIS:
		return KindNSIS
	case TypeAppImage:
		return KindAppImage
	case TypeDeb:
		return KindDeb
	case TypeRPM:
		return KindRPM
	}
	return ""
}

func defaultKind(goos string) Kind {
	switch goos {
	case "darwin":
		return KindApp
	case "windows":
		return KindNSIS
	case "linux":
		return KindAppImage
	}
	return ""
}

// artifactKind returns the kind that Download fetches. That is --package when given, or else the
// install type's own kind, or else the platform's default (for --output and --check from a copy
// that can't update itself).
func (e *Engine) artifactKind() (Kind, error) {
	switch e.opts.Package {
	case "deb", "rpm":
		if runtime.GOOS != "linux" {
			return "", errPackageNotLinux
		}
		return Kind(e.opts.Package), nil
	case "":
	default:
		return "", errPackageValue
	}
	if k := e.InstallType().kind(); k != "" {
		return k, nil
	}
	return defaultKind(runtime.GOOS), nil
}
