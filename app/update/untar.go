package update

import (
	"archive/tar"
	"compress/gzip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/rclone/rclone-ui/core/errs"
)

// maxBundle limits the total size that an update archive may unpack to.
const maxBundle = 2 << 30

// untarBundle unpacks a .app.tar.gz into dst, dropping its top folder. The archive has one top
// folder, "Rclone UI.app/", as build/package.sh writes it. Paths may not leave dst, and links may
// only point inside it. A bundle is executable code, and this runs before anything else checks
// it. Every write goes through an os.Root on dst, because checking the names alone would miss a
// chain of the archive's own links that leads out ("d/up" → "..", then "d/up/up2" → "..").
func untarBundle(archive, dst string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return errs.Errorf("the update isn't a .tar.gz: %w", err)
	}
	defer func() { _ = gz.Close() }()
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	root, err := os.OpenRoot(dst)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	tr := tar.NewReader(gz)
	var total int64
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return errs.Errorf("the update archive is damaged: %w", err)
		}
		rel, err := innerPath(hdr.Name)
		if err != nil {
			return err
		}
		if rel == "" {
			continue // skip the top folder itself
		}
		target := filepath.FromSlash(rel)
		mode := os.FileMode(hdr.Mode).Perm()
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(target, mode|0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if total += hdr.Size; total > maxBundle {
				return errs.New("the update archive is too large")
			}
			if err := root.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := writeFile(root, target, tr, mode); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if !linkStaysInside(rel, hdr.Linkname) {
				return fmt.Errorf("the update archive links %s outside the app", hdr.Name)
			}
			if err := root.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := root.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		case tar.TypeXGlobalHeader:
		default:
			return fmt.Errorf("the update archive holds an unexpected entry: %s", hdr.Name)
		}
	}
	return nil
}

// innerPath returns an entry's path below the top folder, or an error when the path would leave
// it.
func innerPath(name string) (string, error) {
	clean := path.Clean(strings.TrimPrefix(name, "./"))
	if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("the update archive holds an unsafe path: %s", name)
	}
	_, rest, _ := strings.Cut(clean, "/")
	return rest, nil
}

// linkStaysInside reports whether a symlink at rel (a slash-separated path below the bundle) that
// points to target resolves inside the bundle.
func linkStaysInside(rel, target string) bool {
	if target == "" || path.IsAbs(target) {
		return false
	}
	resolved := path.Clean(path.Join(path.Dir(rel), target))
	return resolved != ".." && !strings.HasPrefix(resolved, "../")
}

func writeFile(root *os.Root, name string, r io.Reader, mode os.FileMode) (err error) {
	out, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := out.Close(); err == nil {
			err = cerr
		}
	}()
	_, err = io.Copy(out, r)
	return err
}

// plistString reads one string value from an XML property list's top dictionary.
func plistString(file, key string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	dec := xml.NewDecoder(f)
	dec.Strict = false
	depth, wantValue := 0, false
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return "", fmt.Errorf("%s has no %s", file, key)
		}
		if err != nil {
			return "", fmt.Errorf("%s: %w", file, err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			// In <plist><dict><key>, the top dictionary's entries are at depth 3.
			if depth != 3 {
				continue
			}
			var text string
			if err := dec.DecodeElement(&text, &t); err != nil {
				return "", fmt.Errorf("%s: %w", file, err)
			}
			depth--
			switch {
			case wantValue && t.Name.Local == "string":
				return strings.TrimSpace(text), nil
			case t.Name.Local == "key":
				wantValue = strings.TrimSpace(text) == key
			default:
				wantValue = false
			}
		case xml.EndElement:
			depth--
		}
	}
}

// bundleExecutable returns the name of the executable that an .app runs (CFBundleExecutable), and
// checks that it exists.
func bundleExecutable(bundle string) (string, error) {
	name, err := plistString(filepath.Join(bundle, "Contents", "Info.plist"), "CFBundleExecutable")
	if err != nil {
		return "", errs.Errorf("the update isn't an app bundle: %w", err)
	}
	if name == "" || strings.ContainsAny(name, `/\`) {
		return "", fmt.Errorf("the update's CFBundleExecutable is %q", name)
	}
	exe := filepath.Join(bundle, "Contents", "MacOS", name)
	info, err := os.Stat(exe)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("the update's executable %s is missing", name)
	}
	return name, nil
}
