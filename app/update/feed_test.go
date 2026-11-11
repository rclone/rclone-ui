package update

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// feed is a fake release server: /latest/download/<FeedName>, /releases (GitHub's list of the
// newest releases), /v<version>/<FeedName> and /files/.
type feed struct {
	srv    *httptest.Server
	stable *Feed // nil means 404, as before the first stable release
	beta   *Feed // the newest beta: in the list as a pre-release, with its feed. nil means none.
	// listed are more releases of the list, by tag: true for a pre-release. Their feeds are in
	// releases.
	listed map[string]bool
	// limited makes the list answer as GitHub does once it answers no more requests.
	limited   bool
	releases  map[string]*Feed
	files     map[string][]byte
	downloads atomic.Int32
}

func newFeed(t *testing.T) *feed {
	t.Helper()
	f := &feed{releases: map[string]*Feed{}, files: map[string][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *feed) serve(w http.ResponseWriter, r *http.Request) {
	var m *Feed
	switch p := r.URL.Path; {
	case p == "/latest/download/"+FeedName:
		m = f.stable
	case p == "/releases":
		f.serveList(w)
		return
	case strings.HasPrefix(p, "/v") && strings.HasSuffix(p, "/"+FeedName):
		version := strings.TrimSuffix(strings.TrimPrefix(p, "/v"), "/"+FeedName)
		if m = f.releases[version]; m == nil && f.beta != nil && f.beta.Release.Version == version {
			m = f.beta
		}
	case strings.HasPrefix(p, "/files/"):
		b, ok := f.files[strings.TrimPrefix(p, "/files/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		f.downloads.Add(1)
		w.Header().Set("Content-Length", fmt.Sprint(len(b)))
		_, _ = w.Write(b)
		return
	}
	if m == nil {
		http.NotFound(w, r)
		return
	}
	_ = json.NewEncoder(w).Encode(m)
}

// serveList answers as GitHub's list of releases does: the releases that aren't the app's betas
// (the stable ones, and other things released from the same repository), the beta and listed.
func (f *feed) serveList(w http.ResponseWriter) {
	if f.limited {
		w.Header().Set("X-RateLimit-Remaining", "0")
		http.Error(w, `{"message":"API rate limit exceeded"}`, http.StatusForbidden)
		return
	}
	type listed struct {
		Tag        string `json:"tag_name"`
		Prerelease bool   `json:"prerelease"`
		Draft      bool   `json:"draft"`
	}
	list := []listed{{Tag: "cloud-latest"}, {Tag: "v3.7.5"}}
	if f.stable != nil {
		list = append(list, listed{Tag: "v" + f.stable.Release.Version})
	}
	if f.beta != nil {
		list = append(list, listed{Tag: "v" + f.beta.Release.Version, Prerelease: true})
	}
	for tag, pre := range f.listed {
		list = append(list, listed{Tag: tag, Prerelease: pre})
	}
	_ = json.NewEncoder(w).Encode(list)
}

// release makes a feed with the given artifact for kind on every platform. The artifact is served
// at /files/<version>-<kind>.
func (f *feed) release(version, rclone string, kind Kind, content []byte) *Feed {
	name := version + "-" + string(kind)
	f.files[name] = content
	m := &Feed{
		Format:  FeedFormat,
		Release: FeedRelease{Version: version, Notes: "notes", Date: "2026-10-01T12:00:00Z"},
		Rclone:  rclone,
		Files:   map[string]FeedFile{},
		Policy:  Policy{Minimum: "4.0.0", Recommended: "4.0.1"},
	}
	p := FeedFile{URL: f.srv.URL + "/files/" + name}
	for _, goos := range []string{"darwin", "windows", "linux"} {
		for _, arch := range []string{"amd64", "arm64"} {
			m.Files[FileKey(goos, arch, kind)] = p
		}
	}
	return m
}

func (f *feed) options(t *testing.T, current string) Options {
	return Options{
		FeedURL:        f.srv.URL + "/latest/download/" + FeedName,
		BetaListURL:    f.srv.URL + "/releases",
		ReleaseFeedURL: f.srv.URL + "/v{version}/" + FeedName,
		HTTPClient:     f.srv.Client(),
		CurrentVersion: current,
		StagingDir:     t.TempDir(),
	}
}

// engineFor returns an engine that believes it is an install of type it.
func engineFor(opts Options, it InstallType, location string) *Engine {
	e := New(opts)
	e.installed, e.location = it, location
	e.detect()
	return e
}

// nativeType returns this OS's own install type and artifact kind.
func nativeType() (InstallType, Kind) {
	switch runtime.GOOS {
	case "darwin":
		return TypeApp, KindApp
	case "windows":
		return TypeNSIS, KindNSIS
	}
	return TypeAppImage, KindAppImage
}

// artifactBytes returns file contents that pass checkKind for kind.
func artifactBytes(kind Kind) []byte {
	head := map[Kind][]byte{
		KindApp:      {0x1f, 0x8b},
		KindNSIS:     []byte("MZ"),
		KindAppImage: []byte("\x7fELF\x02\x01\x01\x00AI\x02"),
		KindDeb:      []byte("!<arch>\n"),
		KindRPM:      {0xed, 0xab, 0xee, 0xdb},
	}[kind]
	return append(append([]byte{}, head...), bytes.Repeat([]byte("rclone ui "), 1000)...)
}

func TestFileKey(t *testing.T) {
	for _, c := range []struct {
		goos, arch string
		kind       Kind
		want       string
	}{
		{"darwin", "arm64", KindApp, "darwin-arm64-app"},
		{"windows", "amd64", KindNSIS, "windows-amd64-nsis"},
		{"linux", "arm64", KindAppImage, "linux-arm64-appimage"},
		{"linux", "amd64", KindDeb, "linux-amd64-deb"},
		{"linux", "arm64", KindRPM, "linux-arm64-rpm"},
	} {
		if got := FileKey(c.goos, c.arch, c.kind); got != c.want {
			t.Errorf("FileKey(%s, %s, %s) = %q, want %q", c.goos, c.arch, c.kind, got, c.want)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"4.0.2", "4.0.1", 1},
		{"v4.0.1", "4.0.1", 0},
		{"4.1.0-beta.1", "4.0.9", 1},
		{"4.1.0-beta.1", "4.1.0", -1},
		// The betas of a version are numbered, and the numbers are compared as numbers.
		{"4.1.0-beta.1", "4.1.0-beta.2", -1},
		{"4.1.0-beta.2", "4.1.0-beta.10", -1},
		{"3.7.5", "4.0.0", -1},
		{"4.0.0", "dev", 1}, // a dev build is older than any release
		{"dev", "dev", 0},
	} {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCheckStable(t *testing.T) {
	it, kind := nativeType()
	f := newFeed(t)
	f.stable = f.release("4.0.2", "v1.76.2", kind, artifactBytes(kind))
	e := engineFor(f.options(t, "4.0.1"), it, "/somewhere")
	rel, err := e.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rel.Version != "4.0.2" || rel.Rclone != "v1.76.2" || rel.Kind != kind || !rel.Newer() || rel.Same() {
		t.Errorf("Check = %+v", rel)
	}
	if want := FileKey(runtime.GOOS, runtime.GOARCH, kind); rel.Key != want {
		t.Errorf("key = %q, want %q", rel.Key, want)
	}
	if got := rel.Describe(); got != "4.0.2 (rclone v1.76.2)" {
		t.Errorf("Describe = %q", got)
	}
	if rel.PubDate.IsZero() {
		t.Error("the release date wasn't parsed")
	}
	if rel.Policy != (Policy{Minimum: "4.0.0", Recommended: "4.0.1"}) {
		t.Errorf("policy = %+v", rel.Policy)
	}
}

func TestCheckRefusesOtherFeeds(t *testing.T) {
	it, kind := nativeType()
	for name, change := range map[string]func(*Feed){
		"a newer format":   func(f *Feed) { f.Format = 2 },
		"no format":        func(f *Feed) { f.Format = 0 },
		"no version":       func(f *Feed) { f.Release.Version = "" },
		"a version of old": func(f *Feed) { f.Release.Version = "latest" },
	} {
		t.Run(name, func(t *testing.T) {
			f := newFeed(t)
			f.stable = f.release("4.0.2", "", kind, artifactBytes(kind))
			change(f.stable)
			if _, err := engineFor(f.options(t, "4.0.1"), it, "/x").Check(context.Background()); err == nil {
				t.Fatal("the feed was accepted")
			} else if name == "a newer format" && (!errors.Is(err, ErrFeedFormat) || !strings.Contains(err.Error(), ReleasesList)) {
				t.Errorf("a newer format: %v", err)
			}
		})
	}
}

func TestCheckBetaChannel(t *testing.T) {
	it, kind := nativeType()
	for _, c := range []struct {
		name, stable, beta, want string
	}{
		{"beta newer", "4.0.2", "4.1.0-beta.1", "4.1.0-beta.1"},
		{"stable newer", "4.1.0", "4.1.0-beta.2", "4.1.0"},
		{"no beta yet", "4.0.2", "", "4.0.2"},
		{"no stable release yet", "", "4.0.0-beta.1", "4.0.0-beta.1"},
		// The betas of a version stop once it is released: the release is newer than all of them.
		{"the betas' version is released", "4.0.0", "4.0.0-beta.2", "4.0.0"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFeed(t)
			if c.stable != "" {
				f.stable = f.release(c.stable, "v1.76.2", kind, artifactBytes(kind))
			}
			if c.beta != "" {
				f.beta = f.release(c.beta, "v1.77.0", kind, artifactBytes(kind))
			}
			opts := f.options(t, "4.0.1")
			opts.Channel = Beta
			rel, err := engineFor(opts, it, "/x").Check(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if rel.Version != c.want || rel.Channel != Beta {
				t.Errorf("Check = %s on %s, want %s", rel.Version, rel.Channel, c.want)
			}
		})
	}
}

// A copy that runs a beta is offered the next beta, and then the version that the betas led
// to, once that is released.
func TestCheckFromABeta(t *testing.T) {
	it, kind := nativeType()
	f := newFeed(t)
	f.beta = f.release("4.0.0-beta.2", "v1.77.0", kind, artifactBytes(kind))
	opts := f.options(t, "4.0.0-beta.1")
	opts.Channel = Beta
	rel, err := engineFor(opts, it, "/x").Check(context.Background())
	if err != nil || rel.Version != "4.0.0-beta.2" || !rel.Newer() {
		t.Fatalf("from a beta to the next: %+v %v", rel, err)
	}
	f.stable = f.release("4.0.0", "v1.77.0", kind, artifactBytes(kind))
	for _, ch := range []Channel{Beta, Stable} {
		opts.Channel = ch
		rel, err := engineFor(opts, it, "/x").Check(context.Background())
		if err != nil || rel.Version != "4.0.0" || !rel.Newer() {
			t.Errorf("%s, from a beta to its release: %+v %v", ch, rel, err)
		}
	}
}

// The beta channel takes the newest beta of GitHub's list, whatever the list's order, and nothing
// else in it: a release that isn't marked as a pre-release, or one whose tag isn't a version.
func TestCheckNewestBeta(t *testing.T) {
	it, kind := nativeType()
	f := newFeed(t)
	for _, version := range []string{"4.0.0-beta.2", "4.0.0-beta.10", "4.0.0-beta.9"} {
		f.releases[version] = f.release(version, "v1.77.0", kind, artifactBytes(kind))
	}
	f.listed = map[string]bool{
		"v4.0.0-beta.2": true, "v4.0.0-beta.10": true, "v4.0.0-beta.9": true,
		"v9.0.0-beta.1": false, // not marked as a pre-release
		"nightly":       true,  // not a version
		"v8.0.0":        true,  // a pre-release without a pre-release part: not one of the betas
	}
	opts := f.options(t, "4.0.0-beta.2")
	opts.Channel = Beta
	// The numbers are compared as numbers: beta.10 is after beta.9.
	rel, err := engineFor(opts, it, "/x").Check(context.Background())
	if err != nil || rel.Version != "4.0.0-beta.10" || !rel.Newer() {
		t.Fatalf("Check = %+v %v, want 4.0.0-beta.10", rel, err)
	}
	// A beta whose release was deleted is gone from the list, and the one before it is offered.
	delete(f.listed, "v4.0.0-beta.10")
	if rel, err := engineFor(opts, it, "/x").Check(context.Background()); err != nil || rel.Version != "4.0.0-beta.9" {
		t.Fatalf("after deleting the newest: %+v %v, want 4.0.0-beta.9", rel, err)
	}
	// A feed that describes another version than its release's tag is refused.
	f.releases["4.0.0-beta.9"] = f.release("4.0.0-beta.2", "v1.77.0", kind, artifactBytes(kind))
	if _, err := engineFor(opts, it, "/x").Check(context.Background()); err == nil || !strings.Contains(err.Error(), "describes") {
		t.Errorf("a feed for another version: %v", err)
	}
}

// When GitHub answers no more requests, the beta channel takes the stable release, and says why
// it has nothing when there is no stable release either.
func TestCheckBetaListLimited(t *testing.T) {
	it, kind := nativeType()
	f := newFeed(t)
	f.beta = f.release("4.1.0-beta.1", "v1.77.0", kind, artifactBytes(kind))
	f.limited = true
	opts := f.options(t, "4.0.0")
	opts.Channel = Beta
	if _, err := engineFor(opts, it, "/x").Check(context.Background()); !errors.Is(err, errListLimited) {
		t.Errorf("limited, no stable release: %v, want errListLimited", err)
	}
	f.stable = f.release("4.0.1", "v1.76.2", kind, artifactBytes(kind))
	rel, err := engineFor(opts, it, "/x").Check(context.Background())
	if err != nil || rel.Version != "4.0.1" {
		t.Errorf("limited, with a stable release: %+v %v, want 4.0.1", rel, err)
	}
	// The stable channel never asks for the list.
	opts.Channel = Stable
	if rel, err := engineFor(opts, it, "/x").Check(context.Background()); err != nil || rel.Version != "4.0.1" {
		t.Errorf("the stable channel: %+v %v", rel, err)
	}
}

func TestCheckNoReleaseYet(t *testing.T) {
	it, _ := nativeType()
	f := newFeed(t)
	for _, ch := range []Channel{Stable, Beta} {
		opts := f.options(t, "4.0.0-beta.1")
		opts.Channel = ch
		if _, err := engineFor(opts, it, "/x").Check(context.Background()); !errors.Is(err, ErrNoRelease) {
			t.Errorf("%s: %v, want ErrNoRelease", ch, err)
		}
	}
}

func TestCheckVersion(t *testing.T) {
	it, kind := nativeType()
	f := newFeed(t)
	f.stable = f.release("4.0.2", "v1.76.2", kind, artifactBytes(kind))
	f.releases["4.0.0"] = f.release("4.0.0", "v1.75.1", kind, artifactBytes(kind))
	opts := f.options(t, "4.0.1")
	opts.Version = "v4.0.0"
	rel, err := engineFor(opts, it, "/x").Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Downgrades are allowed, so a release that is neither newer nor the same is accepted.
	if rel.Version != "4.0.0" || rel.Newer() || rel.Same() {
		t.Errorf("Check = %+v", rel)
	}
	opts.Version = "9.9.9"
	if _, err := engineFor(opts, it, "/x").Check(context.Background()); !errors.Is(err, ErrNoRelease) {
		t.Errorf("an unknown version: %v, want ErrNoRelease", err)
	}
}

func TestCheckVersionValues(t *testing.T) {
	for v, want := range map[string]error{
		"":                       nil,
		"4.0.0":                  nil,
		"v4.0.2":                 nil,
		" 4.1.0-beta.1 ":         nil,
		"4.0.0-beta.1":           nil,
		"3.7.5":                  nil, // a version that was never released is ErrNoRelease, from the feed
		"4.0":                    ErrBadVersion,
		"latest":                 ErrBadVersion,
		"4.0.2/../../x":          ErrBadVersion,
		"4.0.2?x=1":              ErrBadVersion,
		"4.0.2-beta/../../3.7.5": ErrBadVersion,
	} {
		if err := CheckVersion(v); !errors.Is(err, want) || (want == nil) != (err == nil) {
			t.Errorf("CheckVersion(%q) = %v, want %v", v, err, want)
		}
	}
}

func TestCheckVersionRefused(t *testing.T) {
	it, kind := nativeType()
	var asked atomic.Int32
	f := newFeed(t)
	f.releases["4.0.3"] = f.release("4.0.1", "", kind, artifactBytes(kind))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked.Add(1)
		f.serve(w, r)
	}))
	t.Cleanup(srv.Close)
	opts := f.options(t, "4.0.1")
	opts.ReleaseFeedURL = srv.URL + "/v{version}/" + FeedName
	opts.Version = "4.0.2/../../latest"
	if _, err := engineFor(opts, it, "/x").Check(context.Background()); !errors.Is(err, ErrBadVersion) {
		t.Errorf("Check(%q) = %v, want ErrBadVersion", opts.Version, err)
	}
	if n := asked.Load(); n != 0 {
		t.Errorf("the feed was asked %d times", n)
	}
	opts.Version = "4.0.3"
	if _, err := engineFor(opts, it, "/x").Check(context.Background()); err == nil || !strings.Contains(err.Error(), "describes 4.0.1") {
		t.Errorf("a feed naming 4.0.1 for 4.0.3: %v", err)
	}
}

func TestCheckNoArtifact(t *testing.T) {
	it, _ := nativeType()
	f := newFeed(t)
	f.stable = f.release("4.0.2", "", Kind("other"), artifactBytes(KindApp))
	if _, err := engineFor(f.options(t, "4.0.1"), it, "/x").Check(context.Background()); !errors.Is(err, ErrNoArtifact) {
		t.Errorf("Check = %v, want ErrNoArtifact", err)
	}
}

func TestCheckPackage(t *testing.T) {
	f := newFeed(t)
	f.stable = f.release("4.0.2", "", KindDeb, artifactBytes(KindDeb))
	opts := f.options(t, "4.0.1")
	opts.Package = "deb"
	rel, err := engineFor(opts, TypeAppImage, "/x").Check(context.Background())
	if runtime.GOOS != "linux" {
		if !errors.Is(err, errPackageNotLinux) {
			t.Errorf("--package deb off Linux: %v", err)
		}
		return
	}
	if err != nil || rel.Kind != KindDeb {
		t.Fatalf("Check = %+v, %v", rel, err)
	}
	opts.Package = "msi"
	if _, err := New(opts).Check(context.Background()); !errors.Is(err, errPackageValue) {
		t.Errorf("--package msi: %v", err)
	}
}

func TestCheckTimeout(t *testing.T) {
	saved := checkTimeout
	checkTimeout = 200 * time.Millisecond
	t.Cleanup(func() { checkTimeout = saved })
	silent := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(silent.Close)

	it, _ := nativeType()
	e := engineFor(Options{FeedURL: silent.URL + "/latest/download/" + FeedName, HTTPClient: silent.Client()}, it, "/x")
	start := time.Now()
	_, err := e.Check(context.Background())
	if err == nil || err.Error() != "the update feed didn't answer within 30 seconds" {
		t.Errorf("Check = %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("Check took %v", d)
	}
}
