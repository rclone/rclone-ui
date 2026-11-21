package update

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
)

// Artifact is a downloaded release artifact.
type Artifact struct {
	// Path is the file. It stays in the engine's staging folder until SaveAs moves it.
	Path    string
	Kind    Kind
	Release *Release
}

// Download fetches rel's artifact into the staging folder, and checks that it arrived whole and
// is the kind the feed says. progress, when not nil, is called at the start, at most every 100 ms
// as bytes arrive, and once the last byte is in. total is -1 when the server doesn't send a
// length. A download that receives nothing for stallTimeout fails.
func (e *Engine) Download(ctx context.Context, rel *Release, progress func(done, total int64)) (*Artifact, error) {
	if rel == nil || rel.URL == "" {
		return nil, ErrNoArtifact
	}
	dir, err := e.stagingDir(rel.Version)
	if err != nil {
		return nil, err
	}
	name := artifactName(rel)
	dst := filepath.Join(dir, name)
	if err := e.get(ctx, rel.URL, dst, progress); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	if err := checkKind(dst, rel.Kind); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return &Artifact{Path: dst, Kind: rel.Kind, Release: rel}, nil
}

// stagingDir makes a new folder for one download, private to this user. It always creates a new
// folder and never reuses an existing one. In a shared temp folder (like /tmp on Linux), a folder
// that another user (or root, after `sudo rcui update`) created first would block the update, or
// let them swap the downloaded file before it is installed.
func (e *Engine) stagingDir(version string) (string, error) {
	dir, err := os.MkdirTemp(e.opts.StagingDir, "rcui-update-"+safeName(version)+"-")
	if err != nil {
		return "", errs.Errorf("could not create the download folder: %w", err)
	}
	return dir, nil
}

// stallTimeout is how long a download may receive nothing before it fails. It is a variable so
// that tests can change it. Without it, a server that stops sending would keep the update at
// "downloading" forever.
var stallTimeout = time.Minute

// errStalled is the error for a download that received nothing for stallTimeout.
var errStalled = errs.New("the server sent nothing for a minute")

// get streams url into dst, and fails unless every byte the server announced arrived.
func (e *Engine) get(ctx context.Context, url, dst string, progress func(done, total int64)) (err error) {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	stall := time.AfterFunc(stallTimeout, func() { cancel(errStalled) })
	defer stall.Stop()
	defer func() {
		if err != nil && errors.Is(context.Cause(ctx), errStalled) {
			err = errs.Errorf("download failed: %w", errStalled)
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent(e.opts.CurrentVersion))
	resp, err := e.opts.HTTPClient.Do(req)
	if err != nil {
		return errs.Errorf("download failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return errs.Errorf("download failed: the server answered %s", resp.Status)
	}

	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}()
	var w io.Writer = f
	if progress != nil {
		progress(0, resp.ContentLength)
		w = io.MultiWriter(w, &progressWriter{total: resp.ContentLength, fn: progress, last: time.Now()})
	}
	n, err := io.Copy(w, &stallReader{r: resp.Body, timer: stall})
	if err != nil {
		return errs.Errorf("download failed: %w", err)
	}
	if progress != nil {
		// The throttled reports may have left out the last bytes.
		progress(n, resp.ContentLength)
	}
	if resp.ContentLength >= 0 && n != resp.ContentLength {
		return errs.Errorf("download failed: got %d of %d bytes", n, resp.ContentLength)
	}
	return f.Sync()
}

// stallReader restarts the stall timer whenever bytes arrive.
type stallReader struct {
	r     io.Reader
	timer *time.Timer
}

func (s *stallReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if n > 0 {
		s.timer.Reset(stallTimeout)
	}
	return n, err
}

// progressEvery is how often a download reports its progress. io.Copy writes every 32 KB, and
// each report becomes an event sent to every window.
const progressEvery = 100 * time.Millisecond

// progressWriter reports the bytes written to it, at most once every progressEvery.
type progressWriter struct {
	done, total int64
	last        time.Time
	fn          func(done, total int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if now := time.Now(); now.Sub(p.last) >= progressEvery {
		p.last = now
		p.fn(p.done, p.total)
	}
	return len(b), nil
}

// urlFileName returns the file name at the end of a URL ("Rclone-UI-4.0.0-macos-arm64.app.tar.gz"), or ""
// when the URL doesn't parse.
func urlFileName(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	name, _ := url.PathUnescape(path.Base(u.Path))
	return name
}

// artifactName returns the artifact's file name from its URL, made safe to store under.
func artifactName(rel *Release) string {
	name := safeName(urlFileName(rel.URL))
	if name == "" || name == "." {
		name = "rclone-ui-" + safeName(rel.Version) + map[Kind]string{
			KindApp: ".app.tar.gz", KindNSIS: "-setup.exe", KindAppImage: ".AppImage", KindDeb: ".deb", KindRPM: ".rpm",
		}[rel.Kind]
	}
	return name
}

// safeName makes sure a file name is a single path element.
func safeName(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r < ' ' {
			return '_'
		}
		return r
	}, s)
}

// checkKind checks the file's first bytes. A feed that points to the wrong file (such as a deb
// where an AppImage belongs) fails here, before anything is replaced.
func checkKind(file string, kind Kind) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, 24)
	n, _ := io.ReadFull(f, head)
	head = head[:n]
	ok := false
	switch kind {
	case KindApp:
		ok = bytes.HasPrefix(head, []byte{0x1f, 0x8b})
	case KindNSIS:
		ok = bytes.HasPrefix(head, []byte("MZ"))
	case KindAppImage:
		// An ELF file with the AppImage type-2 magic at offset 8.
		ok = bytes.HasPrefix(head, []byte("\x7fELF")) && len(head) >= 11 && bytes.Equal(head[8:11], []byte("AI\x02"))
	case KindDeb:
		ok = bytes.HasPrefix(head, []byte("!<arch>\n"))
	case KindRPM:
		ok = bytes.HasPrefix(head, []byte{0xed, 0xab, 0xee, 0xdb})
	default:
		return fmt.Errorf("unknown artifact kind %q", kind)
	}
	if !ok {
		return errs.Errorf("the download isn't a %s artifact", kind)
	}
	return nil
}

// SaveAs moves the artifact to dst (a file, or a folder to put it in) and returns its new path.
// `rcui update --output` uses it.
func (a *Artifact) SaveAs(dst string) (string, error) {
	if info, err := os.Stat(dst); err == nil && info.IsDir() {
		dst = filepath.Join(dst, filepath.Base(a.Path))
	}
	mode := os.FileMode(0o644)
	if a.Kind == KindAppImage {
		mode = 0o755
	}
	if err := os.Rename(a.Path, dst); err != nil {
		if err := copyFile(a.Path, dst, mode); err != nil {
			return "", err
		}
		_ = os.Remove(a.Path)
	}
	if err := os.Chmod(dst, mode); err != nil {
		return "", err
	}
	a.Path = dst
	return dst, nil
}

// Remove deletes the artifact and its staging folder.
func (a *Artifact) Remove() {
	_ = os.Remove(a.Path)
	_ = os.Remove(filepath.Dir(a.Path)) // removed only if empty, since SaveAs may have moved the file
}

// copyFile copies src to dst through a temporary file next to dst.
func copyFile(src, dst string, mode os.FileMode) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".tmp-")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	if _, err = io.Copy(tmp, in); err != nil {
		return err
	}
	if err = tmp.Chmod(mode); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}
