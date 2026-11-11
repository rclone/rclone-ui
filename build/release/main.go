// Command release writes the feed of a release (app/update's Feed, rclone-ui-update.json), and
// checks the files that the release publishes.
//
//	release manifest -version V -base-url URL [-policy FILE] [-rclone V] [-notes TEXT] [-out FILE] DIR
//	    Writes the feed for the files in DIR (named as package.sh names them). Every file must be
//	    there, because leaving one out would stop updates on that platform. The policy is FILE
//	    (build/release/policy.json), which is edited by hand.
//	release check -version V DIR
//	    Checks that DIR holds exactly the files that a release of V publishes (Published).
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/app/update"
)

// artifact is a file of a release that an update installs.
type artifact struct {
	goos, goarch string
	kind         update.Kind
}

// prefix starts the name of every file of a release, so that nothing that looks for another
// app's file names finds them.
func prefix(version string) string { return "Rclone-UI-" + version + "-" }

// updateFiles returns the files of a release of version that an update installs, by the names
// that package.sh gives them.
func updateFiles(version string) map[string]artifact {
	p := prefix(version)
	return map[string]artifact{
		p + "macos-arm64.app.tar.gz":  {"darwin", "arm64", update.KindApp},
		p + "macos-x64.app.tar.gz":    {"darwin", "amd64", update.KindApp},
		p + "windows-x64-setup.exe":   {"windows", "amd64", update.KindNSIS},
		p + "windows-arm64-setup.exe": {"windows", "arm64", update.KindNSIS},
		p + "linux-x86_64.AppImage":   {"linux", "amd64", update.KindAppImage},
		p + "linux-aarch64.AppImage":  {"linux", "arm64", update.KindAppImage},
		p + "linux-amd64.deb":         {"linux", "amd64", update.KindDeb},
		p + "linux-arm64.deb":         {"linux", "arm64", update.KindDeb},
		p + "linux-x86_64.rpm":        {"linux", "amd64", update.KindRPM},
		p + "linux-aarch64.rpm":       {"linux", "arm64", update.KindRPM},
	}
}

// Published returns every file that a release of version publishes, sorted: the update files, the
// disk images, the Windows portable zips, the vendored sources and the Flathub manifest (the
// release workflow's vendor job), and the feed. The portable zips aren't update files, because a
// portable copy doesn't update itself.
func Published(version string) []string {
	p := prefix(version)
	names := []string{p + "macos-arm64.dmg", p + "macos-x64.dmg",
		p + "windows-x64-portable.zip", p + "windows-arm64-portable.zip",
		p + "vendor.tar.gz", "org.rclone.ui.yml", update.FeedName}
	for name := range updateFiles(version) {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "manifest":
		err = manifest(os.Args[2:])
	case "check":
		err = check(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: release manifest -version V -base-url URL DIR | check -version V DIR")
	os.Exit(2)
}

// versionFlag reads -version, without a leading v.
func versionFlag(v string) (string, error) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return "", errors.New("-version is required")
	}
	if err := update.CheckVersion(v); err != nil {
		return "", err
	}
	return v, nil
}

func readPolicy(path string) (update.Policy, error) {
	var p update.Policy
	b, err := os.ReadFile(path)
	if err != nil {
		return p, err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return p, fmt.Errorf("%s: %w", path, err)
	}
	for _, v := range []string{p.Minimum, p.Recommended} {
		if v != "" {
			if err := update.CheckVersion(v); err != nil {
				return p, fmt.Errorf("%s: %w", path, err)
			}
		}
	}
	return p, nil
}

func manifest(args []string) error {
	fs := flag.NewFlagSet("manifest", flag.ContinueOnError)
	versionArg := fs.String("version", "", "the release's version, without a v")
	baseURL := fs.String("base-url", "", "where the files are downloaded from (the release's download URL)")
	policyFile := fs.String("policy", filepath.Join("build", "release", "policy.json"), "the policy file")
	rclone := fs.String("rclone", "", "the rclone version the release brings")
	notes := fs.String("notes", "", "the release notes")
	out := fs.String("out", "", "where to write the feed (default DIR/"+update.FeedName+")")
	if err := fs.Parse(args); err != nil {
		return err
	}
	version, err := versionFlag(*versionArg)
	if err != nil {
		return fmt.Errorf("manifest: %w", err)
	}
	if *baseURL == "" || fs.NArg() != 1 {
		return errors.New("manifest: -base-url and DIR are required")
	}
	dir := fs.Arg(0)
	policy, err := readPolicy(*policyFile)
	if err != nil {
		return err
	}
	f := update.Feed{
		Format:  update.FeedFormat,
		Release: update.FeedRelease{Version: version, Date: time.Now().UTC().Format(time.RFC3339), Notes: *notes},
		Files:   map[string]update.FeedFile{},
		Rclone:  *rclone,
		Policy:  policy,
	}
	files := updateFiles(version)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	slices.Sort(names)
	// Write a feed only when every file is there. A feed without one platform's file would stop
	// updates on that platform, and the next release step would publish it.
	var missing []string
	for _, name := range names {
		_, err := os.Stat(filepath.Join(dir, name))
		if errors.Is(err, os.ErrNotExist) {
			missing = append(missing, name)
			continue
		}
		if err != nil {
			return err
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing %s: every file that an update installs is released (build/package.sh names them); one left out stops that platform's updates",
			strings.Join(missing, ", "))
	}
	for _, name := range names {
		a := files[name]
		f.Files[update.FileKey(a.goos, a.goarch, a.kind)] = update.FeedFile{URL: strings.TrimSuffix(*baseURL, "/") + "/" + name}
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetIndent("", "  ")
	if err := enc.Encode(f); err != nil {
		return err
	}
	if *out == "" {
		*out = filepath.Join(dir, update.FeedName)
	}
	if err := os.WriteFile(*out, b.Bytes(), 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s (%d files)\n", *out, len(f.Files))
	return nil
}

// check fails unless DIR holds exactly Published(version): nothing missing, and nothing else.
func check(args []string) error {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	versionArg := fs.String("version", "", "the release's version, without a v")
	if err := fs.Parse(args); err != nil {
		return err
	}
	version, err := versionFlag(*versionArg)
	if err != nil {
		return fmt.Errorf("check: %w", err)
	}
	if fs.NArg() != 1 {
		return errors.New("check: DIR is required")
	}
	entries, err := os.ReadDir(fs.Arg(0))
	if err != nil {
		return err
	}
	var have []string
	for _, e := range entries {
		have = append(have, e.Name())
	}
	want := Published(version)
	var missing, extra []string
	for _, n := range want {
		if !slices.Contains(have, n) {
			missing = append(missing, n)
		}
	}
	for _, n := range have {
		if !slices.Contains(want, n) {
			extra = append(extra, n)
		}
	}
	if len(missing) > 0 || len(extra) > 0 {
		return fmt.Errorf("the release's files differ from what it publishes: missing %v, not published %v", missing, extra)
	}
	for _, n := range have {
		fmt.Println(n)
	}
	return nil
}
