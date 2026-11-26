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

const maxBundle = 2 << 30

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
			continue
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

func innerPath(name string) (string, error) {
	clean := path.Clean(strings.TrimPrefix(name, "./"))
	if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("the update archive holds an unsafe path: %s", name)
	}
	_, rest, _ := strings.Cut(clean, "/")
	return rest, nil
}

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
