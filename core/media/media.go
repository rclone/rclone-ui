// Package media serves file contents to the pages, through GET and HEAD /media?p=&i=&e=&s=. The
// pages use it for <img>, <video>, the previews and downloads. It listens on its own loopback
// port, because on Windows the webview's asset server holds a whole response in memory. A page
// can't send a credential with those requests, so SignURL signs the path for a limited time and
// the route checks the signature instead.
//
// This is the only route that streams file contents in the app. It supports single and multiple
// ranges (with 416 for a bad range), and checks If-Modified-Since and If-Range against the
// modtime. It always sends a Content-Length when the size is known. A file of unknown size is
// sent whole, even when a range is asked for. The content type comes from rclone, never from the
// body, and the response can't run anything on the page's origin (nosniff, CSP sandbox).
package media

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/chunkedreader"
	"github.com/rclone/rclone/fs/fspath"

	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/logs"
	"github.com/rclone/rclone-ui/core/rclone"
)

// Pattern is the route. ServeMux also routes HEAD requests to a GET pattern.
const Pattern = "GET /media"

const (
	// The chunk sizes for reads. The first chunk is small, so a seek in a video requests little
	// data, and the size doubles as the read goes on, as in rclone's VFS.
	chunkSize    = 16 << 20
	maxChunkSize = 256 << 20

	// Lifetime is how long a signed URL works. It is long enough to watch a film in one go.
	Lifetime = 12 * time.Hour
)

// Signer signs media URLs and serves them (see Listen). The key is made for each process, so a
// URL stops working when the app quits.
type Signer struct {
	key []byte
	now func() time.Time
	// base is the address Listen serves on: http://127.0.0.1:port.
	base string
	srv  *http.Server
}

func NewSigner() *Signer {
	key := make([]byte, 32)
	_, _ = rand.Read(key) // crypto/rand never fails
	return &Signer{key: key, now: time.Now}
}

func (s *Signer) mac(p string, inline bool, exp int64) string {
	h := hmac.New(sha256.New, s.key)
	fmt.Fprintf(h, "%s\x00%t\x00%d", p, inline, exp)
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// Sign returns a URL that serves the file at p, and the time it expires.
func (s *Signer) Sign(p string, inline bool) (string, time.Time) {
	exp := s.now().Add(Lifetime)
	q := url.Values{}
	q.Set("p", p)
	if inline {
		q.Set("i", "1")
	}
	q.Set("e", strconv.FormatInt(exp.Unix(), 10))
	q.Set("s", s.mac(p, inline, exp.Unix()))
	return s.base + "/media?" + q.Encode(), exp
}

// verify returns the path and disposition signed in a request's query, or an error that says
// why the signature isn't valid.
func (s *Signer) verify(q url.Values) (p string, inline bool, err error) {
	p, inline = q.Get("p"), q.Get("i") == "1"
	exp, err := strconv.ParseInt(q.Get("e"), 10, 64)
	if err != nil || p == "" {
		return "", false, errors.New("not a media URL")
	}
	if !hmac.Equal([]byte(q.Get("s")), []byte(s.mac(p, inline, exp))) {
		return "", false, errors.New("the URL's signature is wrong")
	}
	if s.now().Unix() > exp {
		return "", false, errors.New("the URL has expired")
	}
	return p, inline, nil
}

func (s *Signer) Handler() http.Handler {
	return http.HandlerFunc(s.serve)
}

func (s *Signer) serve(w http.ResponseWriter, r *http.Request) {
	p, inline, err := s.verify(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	group := rclone.UIGroup("media", ids.New())
	defer rclone.DeleteGroup(context.WithoutCancel(r.Context()), group)
	// The whole response runs as one rclone job that lasts as long as the read. This keeps the Fs
	// pinned in rclone's cache while the data is sent. It also means a fatal rclone error (such as
	// opening a remote with a bad override) only ends this response, not the app.
	sw := &startedWriter{ResponseWriter: w}
	_, err = rclone.Run(r.Context(), rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		return answer(ctx, sw, r, p, inline)
	})
	if errors.Is(err, errPartway) {
		// The response was sent without a length, so the part that was sent looks whole. Only a
		// cut connection tells the browser. This runs outside the rclone job, which would
		// recover the panic.
		logs.Logger(logs.CompApp, "media").WarnContext(r.Context(), "a file's read failed partway", "error", err)
		panic(http.ErrAbortHandler)
	}
	if err != nil && !sw.started {
		fail(sw, r, err)
	}
}

// errPartway is a read that failed after part of a file of unknown size was sent.
var errPartway = errors.New("the read failed partway")

// startedWriter records whether the response has started, so that a later failure isn't
// written on top of it.
type startedWriter struct {
	http.ResponseWriter
	started bool
}

func (w *startedWriter) WriteHeader(code int) {
	w.started = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *startedWriter) Write(b []byte) (int, error) {
	w.started = true
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the connection's writer.
func (w *startedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// answer writes the file at p to w. ctx is the context of an rclone job. It returns an error
// only while nothing was written, or errPartway.
func answer(ctx context.Context, w http.ResponseWriter, r *http.Request, p string, inline bool) error {
	o, err := object(ctx, p)
	if err != nil {
		return err
	}
	h := w.Header()
	// These are set before anything is written, so nothing is sniffed from the body. The file
	// (such as a user's HTML or SVG) must never run as a page of the app.
	contentType := fs.MimeType(ctx, o)
	h.Set("Content-Type", contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox")
	h.Set("Cache-Control", "private, no-cache")
	h.Set("Content-Disposition", disposition(path.Base(o.Remote()), contentType, inline))

	size := o.Size()
	if size < 0 {
		// http.ServeContent needs the size. A file with an unknown size is streamed whole,
		// without ranges. A range that was asked for is ignored, as HTTP allows: a player gets
		// the whole file with 200 and plays it without seeking.
		if r.Method == http.MethodHead {
			return nil
		}
		in, err := o.Open(ctx)
		if err != nil {
			return err
		}
		defer func() { _ = in.Close() }()
		n, err := io.Copy(w, in)
		switch {
		case err == nil || r.Context().Err() != nil:
			return nil
		case n == 0:
			return err // nothing was sent, so serve answers with the error
		}
		return fmt.Errorf("%w: %w", errPartway, err)
	}
	cr := chunkedreader.New(ctx, o, chunkSize, maxChunkSize, 0)
	defer func() { _ = cr.Close() }()
	http.ServeContent(errorsUnnamed{w}, r, o.Remote(), o.ModTime(ctx), &lazySeeker{cr: cr, size: size})
	return nil
}

// errorsUnnamed drops Content-Disposition from an error that http.ServeContent writes itself,
// such as a 416 for a range past the end, so the error is never saved under the file's name.
type errorsUnnamed struct{ http.ResponseWriter }

func (w errorsUnnamed) WriteHeader(status int) {
	if status >= http.StatusBadRequest {
		w.Header().Del("Content-Disposition")
	}
	w.ResponseWriter.WriteHeader(status)
}

// Unwrap lets http.ResponseController reach the connection's writer.
func (w errorsUnnamed) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// object returns the file at p, which is a full rclone path.
func object(ctx context.Context, p string) (fs.Object, error) {
	parent, leaf, err := fspath.Split(p)
	if err != nil {
		return nil, err
	}
	if leaf == "" {
		return nil, fs.ErrorIsDir
	}
	f, err := cache.Get(ctx, parent)
	if errors.Is(err, fs.ErrorIsFile) {
		// The parent is itself a file. rclone opened its folder instead and reports this.
		_, fileLeaf, splitErr := fspath.Split(strings.TrimRight(parent, "/"))
		if splitErr != nil {
			return nil, splitErr
		}
		leaf = path.Join(fileLeaf, leaf)
	} else if err != nil {
		return nil, err
	}
	return f.NewObject(ctx, leaf)
}

// fail writes a plain text error response. Call it only before anything was written.
func fail(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusBadGateway
	switch {
	case errors.Is(err, fs.ErrorObjectNotFound), errors.Is(err, fs.ErrorDirNotFound),
		errors.Is(err, fs.ErrorNotAFile), errors.Is(err, fs.ErrorIsDir):
		status = http.StatusNotFound
	case r.Context().Err() != nil:
		return
	default:
		logs.Logger(logs.CompApp, "media").WarnContext(r.Context(), "reading a file failed", "error", err)
	}
	// answer may have set the file's headers already. An error must never be saved under the
	// file's name.
	w.Header().Del("Content-Disposition")
	http.Error(w, err.Error(), status)
}

// previewType reports whether the preview shows this content type inline: image, video, audio,
// PDF or plain text. Any other type is always sent as an attachment.
func previewType(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	top, _, _ := strings.Cut(mt, "/")
	return top == "image" || top == "video" || top == "audio" || mt == "application/pdf" || mt == "text/plain"
}

// disposition returns the Content-Disposition for a file called name. It is an attachment,
// unless inline is asked for and the preview can show the type.
func disposition(name, contentType string, inline bool) string {
	kind := "attachment"
	if inline && previewType(contentType) {
		kind = "inline"
	}
	return fmt.Sprintf("%s; filename*=UTF-8''%s", kind, encodeFilename(name))
}

// encodeFilename percent-encodes every byte except ASCII letters and digits, as an RFC 8187
// value.
func encodeFilename(name string) string {
	var b strings.Builder
	for i := range len(name) {
		c := name[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// lazySeeker wraps the chunked reader for http.ServeContent. ServeContent seeks to the end to
// learn the size and then back, but the chunked reader refuses that seek. Here a seek only
// records the position, and the next Read moves the reader there, which opens the range.
type lazySeeker struct {
	cr     chunkedreader.ChunkedReader
	size   int64
	off    int64
	moved  bool
	failed error
}

func (s *lazySeeker) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += s.off
	case io.SeekEnd:
		offset += s.size
	default:
		return 0, errors.New("media: bad whence")
	}
	if offset < 0 {
		return 0, errors.New("media: seek before the start")
	}
	s.off, s.moved = offset, true
	return offset, nil
}

func (s *lazySeeker) Read(p []byte) (int, error) {
	if s.failed != nil {
		return 0, s.failed
	}
	if s.off >= s.size {
		return 0, io.EOF
	}
	if s.moved {
		if _, err := s.cr.Seek(s.off, io.SeekStart); err != nil {
			s.failed = err
			return 0, err
		}
		s.moved = false
	}
	n, err := s.cr.Read(p)
	s.off += int64(n)
	return n, err
}
