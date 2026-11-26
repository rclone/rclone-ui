// Package linkresolve finds the media address behind a web page address, for the Download page.
// The page accepts addresses of web pages (such as a TikTok video or a SoundCloud track), but
// copyurl needs the address of the media itself. A free third-party service that needs no key
// finds that address. The core calls the service, because a web page can't (CORS), and then
// picks a name for the file. Only addresses of the sites listed here are ever sent to it.
package linkresolve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// Service is the link service. Its endpoints and responses are documented at
	// <Service>/docs/api-reference.
	Service     = "https://backend1.tioo.eu.org"
	agent       = "btch/6.4.0"
	titleLength = 42
	maxAnswer   = 4 << 20
	// Timeout is the limit for one request to the service or a media host. It is set on the
	// client passed to New (httpx.New(Timeout)).
	Timeout = 20 * time.Second
)

type site struct {
	name     string
	endpoint string
	hosts    []string
}

var sites = []site{
	{"Instagram", "igdl", []string{"instagram.com"}},
	{"TikTok", "ttdl", []string{"tiktok.com"}},
	{"Facebook", "fbdown", []string{"facebook.com"}},
	{"X (Twitter)", "twitter", []string{"twitter.com", "x.com"}},
	{"YouTube", "youtube", []string{"youtube.com", "youtu.be"}},
	{"MediaFire", "mediafire", []string{"mediafire.com"}},
	{"CapCut", "capcut", []string{"capcut.com"}},
	{"Google Drive", "gdrive", []string{"drive.google.com"}},
	{"Pinterest", "pinterest", []string{"pin.it", "pinterest.com"}},
	{"Douyin", "douyin", []string{"douyin.com"}},
	{"Rednote (Xiaohongshu)", "rednote", []string{"xhslink.com", "xiaohongshu.com"}},
	{"Threads", "threads", []string{"threads.net", "threads.com"}},
	{"Kuaishou", "kuaishou", []string{"kuaishou.com"}},
	{"SnackVideo", "snackvideo", []string{"snackvideo.com"}},
	{"Cocofun", "cocofun", []string{"icocofun.com"}},
	{"Spotify", "spotify", []string{"spotify.com"}},
	{"SoundCloud", "soundcloud", []string{"soundcloud.com"}},
}

var knownExtensions = []string{
	"mp4", "m4v", "webm", "mov", "avi", "wmv", "flv", "mkv", "mp3", "m4a", "aac", "ogg", "wav",
	"jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "apk", "zip", "rar", "7z",
	"pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx",
}

var mimeExtensions = map[string]string{
	"video/quicktime":              "mov",
	"video/x-msvideo":              "avi",
	"video/x-ms-wmv":               "wmv",
	"video/x-flv":                  "flv",
	"video/x-matroska":             "mkv",
	"audio/mpeg":                   "mp3",
	"audio/mp4":                    "m4a",
	"image/jpeg":                   "jpg",
	"image/svg+xml":                "svg",
	"application/x-7z-compressed":  "7z",
	"application/x-rar-compressed": "rar",
	"application/vnd.android.package-archive": "apk",
}

// Sites lists the websites whose addresses are resolved, in the order the page shows them.
func Sites() []Site {
	out := make([]Site, len(sites))
	for i, s := range sites {
		out[i] = Site{Name: s.name, Hosts: slices.Clone(s.hosts)}
	}
	return out
}

type Resolver struct {
	client  *http.Client
	service string
}

func New(client *http.Client, service string) *Resolver {
	return &Resolver{client: client, service: strings.TrimSuffix(service, "/")}
}

// ErrNoAnswer is the error of a lookup that got no answer from the service: no connection, or no
// answer within Timeout.
var ErrNoAnswer = errors.New("the link service did not answer")

// Resolve returns the media behind pageURL. It returns nil without an error when the address
// isn't on a listed site, or when the service finds nothing behind it. The address is then
// downloaded as it is. An error means the service couldn't be reached (ErrNoAnswer), or sent a
// response that can't be used: an error of its own, or something that isn't an address.
func (r *Resolver) Resolve(ctx context.Context, pageURL string) (*Link, error) {
	endpoint := endpointFor(pageURL)
	if endpoint == "" {
		return nil, nil
	}
	return r.resolveWith(ctx, endpoint, pageURL)
}

// Listed reports whether pageURL is an address of one of Sites, which Resolve looks up.
func Listed(pageURL string) bool { return endpointFor(pageURL) != "" }

func endpointFor(pageURL string) string {
	u, err := url.Parse(pageURL)
	if err != nil || u.Host == "" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	for _, s := range sites {
		for _, h := range s.hosts {
			if host == h || strings.HasSuffix(host, "."+h) {
				return s.endpoint
			}
		}
	}
	return ""
}

func (r *Resolver) resolveWith(ctx context.Context, endpoint, pageURL string) (*Link, error) {
	ask := r.service + "/api/downloader/" + endpoint + "?" + url.Values{"url": {pageURL}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ask, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", agent)
	resp, err := r.client.Do(req)
	if err != nil {
		// Go's error quotes the whole request, which holds the page's address. Only its cause
		// is kept, so the address stays out of the log.
		var asked *url.Error
		if errors.As(err, &asked) {
			err = asked.Err
		}
		return nil, fmt.Errorf("%w: %w", ErrNoAnswer, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("the link service answered %s", resp.Status)
	}
	var data any
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxAnswer)).Decode(&data); err != nil {
		return nil, fmt.Errorf("the link service answered something unreadable: %w", err)
	}
	f, ok := find(endpoint, data)
	if !ok {
		return nil, nil
	}
	media, err := url.Parse(f.url)
	if err != nil || (media.Scheme != "http" && media.Scheme != "https") || media.Host == "" {
		return nil, errors.New("the link service answered with something that is not a web address")
	}

	stem, ext := splitTitle(f.title, f.kind)
	if own := strings.ToLower(strings.TrimLeft(f.extension, ".")); ext == "" && plausibleExtension(own) {
		ext = own
	}
	if ext == "" {
		ext = extensionFromURL(media)
	}
	if ext == "" {
		ext = r.extensionFromHeaders(ctx, f.url)
	}
	if ext == "" {
		ext = map[Kind]string{KindVideo: "mp4", KindAudio: "mp3", KindImage: "jpg"}[f.kind]
	}
	name := stem
	if ext != "" {
		name += "." + ext
	}
	return &Link{URL: f.url, Filename: name, Type: f.kind}, nil
}

type found struct {
	title, url string
	kind       Kind
	extension  string
}

func at(v any, path ...any) any {
	for _, step := range path {
		switch k := step.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = m[k]
		case int:
			a, ok := v.([]any)
			if !ok || k >= len(a) {
				return nil
			}
			v = a[k]
		}
	}
	return v
}

func text(v any) string {
	s, _ := v.(string)
	return s
}

func firstText(vs ...any) string {
	for _, v := range vs {
		if s := text(v); s != "" {
			return s
		}
	}
	return ""
}

func find(endpoint string, d any) (found, bool) {
	titled := func(v any, fallback string) string {
		if s := text(v); s != "" {
			return s
		}
		return fallback
	}
	f := func(title, u string, kind Kind) (found, bool) {
		return found{title: title, url: u, kind: kind}, u != ""
	}
	switch endpoint {
	case "igdl":
		items, _ := d.([]any)
		for _, item := range items {
			if u := text(at(item, "url")); u != "" {
				return f("Instagram Video", strings.ReplaceAll(u, "&dl=1", ""), KindVideo)
			}
		}
		return found{}, false
	case "ttdl":
		return f(titled(at(d, "title"), "TikTok Video"), text(at(d, "video", 0)), KindVideo)
	case "youtube":
		return f(titled(at(d, "title"), "YouTube Video"), text(at(d, "mp4")), KindVideo)
	case "fbdown":
		return f("Facebook Video", firstText(at(d, "HD"), at(d, "Normal_video")), KindVideo)
	case "twitter":
		urls, ok := at(d, "url").([]any)
		if !ok {
			return found{}, false
		}
		var u string
		for _, key := range []string{"hd", "sd"} {
			for _, each := range urls {
				if u = text(at(each, key)); u != "" {
					break
				}
			}
			if u != "" {
				break
			}
		}
		return f(titled(at(d, "title"), "Twitter Video"), u, KindVideo)
	case "spotify":
		format := at(d, "res_data", "formats", 0)
		r, ok := f(titled(at(d, "res_data", "title"), "Spotify Audio"), text(at(format, "url")), KindAudio)
		r.extension = text(at(format, "ext"))
		return r, ok
	case "soundcloud":
		return f(titled(at(d, "title"), "SoundCloud Audio"), firstText(at(d, "downloadMp3"), at(d, "audio")), KindAudio)
	case "pinterest":
		if u := text(at(d, "result", "video_url")); u != "" {
			return f("Pinterest Video", u, KindVideo)
		}
		return f("Pinterest Image", text(at(d, "result", "image")), KindImage)
	case "douyin":
		return f(titled(at(d, "data", "title"), "Douyin Video"), text(at(d, "data", "links", 0, "url")), KindVideo)
	case "snackvideo":
		return f(titled(at(d, "title"), "Snackvideo Video"), text(at(d, "videoUrl")), KindVideo)
	case "cocofun":
		return f(titled(at(d, "topic"), "Cocofun Video"), firstText(at(d, "no_watermark"), at(d, "watermark")), KindVideo)
	case "capcut":
		return f(titled(at(d, "title"), "Capcut Video"), text(at(d, "originalVideoUrl")), KindVideo)
	case "gdrive":
		return f(titled(at(d, "data", "filename"), "Google Drive File"), text(at(d, "data", "downloadUrl")), KindFile)
	case "mediafire":
		r, ok := f(titled(at(d, "filename"), "MediaFire File"), text(at(d, "url")), KindFile)
		r.extension = text(at(d, "ext"))
		return r, ok
	case "rednote":
		note := at(d, "result")
		title := titled(at(note, "title"), "Rednote")
		if u := text(at(note, "downloads", 0, "url")); u != "" {
			return f(title, u, KindVideo)
		}
		return f(title, text(at(note, "images", 0)), KindImage)
	case "threads":
		if u := text(at(d, "video")); u != "" {
			return f("Threads Video", u, KindVideo)
		}
		return f("Threads Image", text(at(d, "image")), KindImage)
	case "kuaishou":
		return f(titled(at(d, "title"), "Kuaishou Video"), text(at(d, "videoUrl")), KindVideo)
	}
	return found{}, false
}

func isKnown(ext string) bool { return slices.Contains(knownExtensions, ext) }

func knownSuffix(name string) string {
	i := strings.LastIndex(name, ".")
	if i < 0 {
		return ""
	}
	if s := strings.ToLower(name[i+1:]); isKnown(s) {
		return s
	}
	return ""
}

type pair struct{ key, value string }

func queryPairs(raw string) []pair {
	var out []pair
	for part := range strings.SplitSeq(raw, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		out = append(out, pair{unescape(k), unescape(v)})
	}
	return out
}

func unescape(s string) string {
	if d, err := url.QueryUnescape(s); err == nil {
		return d
	}
	return s
}

func extensionFromURL(u *url.URL) string {
	pairs := queryPairs(u.RawQuery)
	param := func(keys ...string) string {
		for _, p := range pairs {
			if slices.Contains(keys, p.key) {
				return strings.ToLower(p.value)
			}
		}
		return ""
	}
	if ext := extensionFromMime(param("mime", "mime_type", "type", "content_type")); ext != "" {
		return ext
	}
	if ext := knownSuffix(u.Path); ext != "" {
		return ext
	}
	if ext := param("ext", "format", "container", "filetype"); isKnown(ext) {
		return ext
	}
	for _, p := range pairs {
		if ext := knownSuffix(p.value); ext != "" {
			return ext
		}
	}
	return ""
}

func extensionFromMime(mime string) string {
	m, _, _ := strings.Cut(mime, ";")
	m = strings.ReplaceAll(strings.ToLower(strings.TrimSpace(m)), "_", "/")
	if ext, ok := mimeExtensions[m]; ok {
		return ext
	}
	if _, sub, ok := strings.Cut(m, "/"); ok && isKnown(sub) {
		return sub
	}
	return ""
}

func extensionFromDisposition(disposition string) string {
	for part := range strings.SplitSeq(disposition, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || !strings.HasPrefix(strings.ToLower(strings.TrimSpace(key)), "filename") {
			continue
		}
		if ext := knownSuffix(strings.Trim(strings.TrimSpace(value), `"`)); ext != "" {
			return ext
		}
	}
	return ""
}

func (r *Resolver) extensionFromHeaders(ctx context.Context, media string) string {
	for _, method := range []string{http.MethodHead, http.MethodGet} {
		req, err := http.NewRequestWithContext(ctx, method, media, nil)
		if err != nil {
			return ""
		}
		if method == http.MethodGet {
			req.Header.Set("Range", "bytes=0-0")
		}
		resp, err := r.client.Do(req)
		if err != nil {
			continue
		}
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			continue
		}
		ext := extensionFromDisposition(resp.Header.Get("Content-Disposition"))
		if ext == "" {
			ext = extensionFromMime(resp.Header.Get("Content-Type"))
		}
		if ext != "" {
			return ext
		}
	}
	return ""
}

var unsafeInNames = strings.NewReplacer(
	`"`, "'", ":", " - ", "/", "-", `\`, "-", "|", "-", "<", "(", ">", ")", "?", " ", "*", " ",
)

func unescapeHTML(s string) string {
	for range 3 {
		u := html.UnescapeString(s)
		if u == s {
			break
		}
		s = u
	}
	return s
}

func splitTitle(title string, kind Kind) (stem, own string) {
	var b strings.Builder
	for _, c := range unescapeHTML(title) {
		if unicode.IsControl(c) {
			c = ' '
		}
		b.WriteRune(c)
	}
	clean := strings.Join(strings.Fields(unsafeInNames.Replace(b.String())), " ")
	stem = clean
	if i := strings.LastIndex(clean, "."); i >= 0 {
		s, suffix := clean[:i], clean[i+1:]
		if s != "" && plausibleExtension(suffix) && (kind == KindFile || isKnown(strings.ToLower(suffix))) {
			stem, own = s, suffix
		}
	}
	stem = strings.TrimSpace(stem)
	if utf8.RuneCountInString(stem) > titleLength {
		stem = string([]rune(stem)[:titleLength])
	}
	return strings.TrimSpace(stem), own
}

func plausibleExtension(s string) bool {
	return len(s) >= 1 && len(s) <= 8 && alphanumeric(s)
}

func alphanumeric(s string) bool {
	for _, c := range s {
		if !unicode.IsLetter(c) && !unicode.IsNumber(c) {
			return false
		}
	}
	return true
}
