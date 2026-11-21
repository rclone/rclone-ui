package linkresolve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/internal/late"
)

func TestASiteIsItsHostNotAMentionOfIt(t *testing.T) {
	for _, tc := range []struct{ url, want string }{
		{"https://www.youtube.com/watch?v=1", "youtube"},
		{"https://youtu.be/1", "youtube"},
		{"https://vm.tiktok.com/abc", "ttdl"},
		{"https://X.com/a/status/1", "twitter"},
		{"https://example.com/?from=youtube.com", ""},
		{"https://notx.com/a", ""},
		{"https://docs.google.com/document/d/1", ""},
		{"https://drive.google.com/file/d/1", "gdrive"},
		{"not a url", ""},
		{"", ""},
	} {
		if got := endpointFor(tc.url); got != tc.want {
			t.Errorf("endpointFor(%q) = %q, want %q", tc.url, got, tc.want)
		}
	}
}

func TestEachAnswerGivesItsBestAddress(t *testing.T) {
	for _, tc := range []struct {
		endpoint, data string
		title, url     string // an empty url means nothing was found
	}{
		{"igdl", `[{"thumbnail":"t"},{"url":"https://i/v.mp4?x=1&dl=1"}]`, "Instagram Video", "https://i/v.mp4?x=1"},
		{"twitter", `{"title":"T","url":[{"sd":"sd"},{"hd":"hd"}]}`, "T", "hd"},
		{"twitter", `{"url":[{"sd":"sd"}]}`, "Twitter Video", "sd"},
		{"soundcloud", `{"title":"S","audio":"a","downloadMp3":"d"}`, "S", "d"},
		{"fbdown", `{"Normal_video":"n","HD":"h"}`, "Facebook Video", "h"},
		{"cocofun", `{"watermark":"w"}`, "Cocofun Video", "w"},
		{"pinterest", `{"result":{"image":"i"}}`, "Pinterest Image", "i"},
		{"rednote", `{"result":{"title":"R","images":["i"],"downloads":[]}}`, "R", "i"},
		{"threads", `{"type":"video","video":"v"}`, "Threads Video", "v"},
		{"kuaishou", `{"videoUrl":"k"}`, "Kuaishou Video", "k"},
		{"douyin", `{"data":{"links":[{"url":"u"}]}}`, "Douyin Video", "u"},
		{"spotify", `{"res_data":{"title":"Song","formats":[{"url":"s","ext":"m4a"}]}}`, "Song", "s"},
		// This is what the service currently returns for a YouTube address: a status and
		// nothing else.
		{"youtube", `{"status":true}`, "", ""},
		{"gdrive", `{"success":true,"message":"404"}`, "", ""},
		{"no-such", `{}`, "", ""},
	} {
		var d any
		if err := json.Unmarshal([]byte(tc.data), &d); err != nil {
			t.Fatal(err)
		}
		f, ok := find(tc.endpoint, d)
		if tc.url == "" {
			if ok {
				t.Errorf("%s %s: found %+v, want nothing", tc.endpoint, tc.data, f)
			}
			continue
		}
		if !ok || f.title != tc.title || f.url != tc.url {
			t.Errorf("%s %s: (%q, %q, %v), want (%q, %q)", tc.endpoint, tc.data, f.title, f.url, ok, tc.title, tc.url)
		}
	}
}

func TestAnAddressSaysWhatItHolds(t *testing.T) {
	for _, tc := range []struct{ url, want string }{
		{"https://cdn.example/a/clip.MP4?token=1", "mp4"},
		{"https://v.example/videoplayback?mime=video%2Fmp4", "mp4"},
		{"https://v.example/get?mime_type=video_mp4", "mp4"},
		{"https://v.example/get.php?filename=song.mp3", "mp3"},
		{"https://v.example/get?format=webm", "webm"},
		{"https://dl.example/download?token=abc", ""},
	} {
		u, err := url.Parse(tc.url)
		if err != nil {
			t.Fatal(err)
		}
		if got := extensionFromURL(u); got != tc.want {
			t.Errorf("extensionFromURL(%s) = %q, want %q", tc.url, got, tc.want)
		}
	}
}

func TestHeadersSayWhatAFileIs(t *testing.T) {
	for _, tc := range []struct {
		fn       func(string) string
		in, want string
	}{
		{extensionFromMime, "audio/mpeg", "mp3"},
		{extensionFromMime, "video/mp4; codecs=avc1", "mp4"},
		{extensionFromMime, "text/html; charset=utf-8", ""},
		{extensionFromDisposition, `attachment; filename="My Clip.mp4"`, "mp4"},
		{extensionFromDisposition, "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", "pdf"},
		{extensionFromDisposition, "inline", ""},
	} {
		if got := tc.fn(tc.in); got != tc.want {
			t.Errorf("%q → %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestATitleBecomesAStem(t *testing.T) {
	for _, tc := range []struct {
		title     string
		kind      Kind
		stem, own string
	}{
		{`A: "quoted" / title?`, KindVideo, "A - 'quoted' - title", ""},
		// HTML entities are decoded, including twice-encoded ones, and characters that some file
		// system refuses become similar characters.
		{"Tom &amp; Jerry &#39;Best Of&#39;", KindVideo, "Tom & Jerry 'Best Of'", ""},
		{"Q&amp;amp;A &lt;live&gt;", KindVideo, "Q&A (live)", ""},
		{"&quot;Hit&quot; | Artist&nbsp;Name", KindAudio, "'Hit' - Artist Name", ""},
		{"AC/DC: Live*\x00at\tWembley?", KindVideo, "AC-DC - Live at Wembley", ""},
		{"Why?Not", KindVideo, "Why Not", ""},
		{strings.Repeat("é", 60), KindAudio, strings.Repeat("é", 42), ""},
		{"Release v2.0", KindVideo, "Release v2.0", ""},
		{"Google Drive File", KindFile, "Google Drive File", ""},
		// A file name keeps its extension, whether or not it is a known one, so it never becomes
		// `report.pdf.pdf`.
		{"report.pdf", KindFile, "report", "pdf"},
		{"data.parquet", KindFile, "data", "parquet"},
		{"Song.mp3", KindAudio, "Song", "mp3"},
		{"  spaced \t out  ", KindVideo, "spaced out", ""},
	} {
		stem, own := splitTitle(tc.title, tc.kind)
		if stem != tc.stem || own != tc.own {
			t.Errorf("splitTitle(%q) = (%q, %q), want (%q, %q)", tc.title, stem, own, tc.stem, tc.own)
		}
	}
}

func TestSitesNameEveryHost(t *testing.T) {
	names := map[string]bool{}
	for _, s := range Sites() {
		if s.Name == "" || len(s.Hosts) == 0 || names[s.Name] {
			t.Errorf("site %+v", s)
		}
		names[s.Name] = true
		for _, h := range s.Hosts {
			if endpointFor("https://"+h+"/x") == "" {
				t.Errorf("host %s of %s resolves nowhere", h, s.Name)
			}
		}
	}
	if !names["Google Drive"] || !names["Rednote (Xiaohongshu)"] {
		t.Errorf("sites %v", names)
	}
}

// standIn plays both the link service and the media host, on one server.
func standIn(t *testing.T) (*Resolver, string) {
	t.Helper()
	mux := http.NewServeMux()
	var origin string
	mux.HandleFunc("GET /api/downloader/soundcloud", func(w http.ResponseWriter, r *http.Request) {
		ours := r.Header.Get("User-Agent") == agent
		asked := r.URL.Query().Get("url") == "https://soundcloud.com/a/b"
		if !ours || !asked {
			_ = json.NewEncoder(w).Encode(map[string]any{"status": false})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": true, "title": "A track", "audio": origin + "/media?token=abc"})
	})
	mux.HandleFunc("/media", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
	})
	mux.HandleFunc("GET /api/downloader/gdrive", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true,
			"data": map[string]any{"filename": "GIF.png", "downloadUrl": "http://127.0.0.1:9/x"}})
	})
	mux.HandleFunc("GET /api/downloader/youtube", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"status": true})
	})
	mux.HandleFunc("GET /api/downloader/ttdl", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"video": []string{"javascript:alert(1)"}})
	})
	mux.HandleFunc("GET /api/downloader/fbdown", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>"))
	})
	mux.HandleFunc("GET /api/downloader/mediafire", func(w http.ResponseWriter, r *http.Request) {
		ext := map[string]string{"https://mediafire.com/a": "mp3/../x", "https://mediafire.com/b": ".M4A"}[r.URL.Query().Get("url")]
		_ = json.NewEncoder(w).Encode(map[string]any{"filename": "Archive", "url": origin + "/dl/archive.zip", "ext": ext})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	origin = srv.URL
	return New(srv.Client(), srv.URL), srv.URL
}

// TestAServiceExtensionIsOneName checks that the extension the service reports is used only when
// it could follow a name's dot. One with a separator in it is ignored, and the extension comes
// from the address instead.
func TestAServiceExtensionIsOneName(t *testing.T) {
	r, _ := standIn(t)
	for page, want := range map[string]string{"https://mediafire.com/a": "Archive.zip", "https://mediafire.com/b": "Archive.m4a"} {
		got, err := r.Resolve(context.Background(), page)
		if err != nil || got == nil || got.Filename != want {
			t.Errorf("%s: %+v (%v), want %s", page, got, err, want)
		}
	}
}

func TestAPageAddressBecomesTheMediaBehindIt(t *testing.T) {
	r, origin := standIn(t)
	ctx := context.Background()

	// The address has no extension, so the extension comes from the media host's Content-Type.
	got, err := r.Resolve(ctx, "https://soundcloud.com/a/b")
	want := Link{URL: origin + "/media?token=abc", Filename: "A track.mp3", Type: KindAudio}
	if err != nil || got == nil || *got != want {
		t.Fatalf("soundcloud: %+v (%v), want %+v", got, err, want)
	}
	// Google Drive already gives a file name, so the media host isn't contacted. (It doesn't even
	// exist here.)
	drive, err := r.Resolve(ctx, "https://drive.google.com/file/d/1")
	if err != nil || drive == nil || drive.Filename != "GIF.png" || drive.Type != KindFile {
		t.Fatalf("gdrive: %+v (%v)", drive, err)
	}
	// An address with nothing behind it, and one on a site that isn't listed (and so is never
	// sent), are downloaded as they are.
	for _, u := range []string{"https://youtu.be/1", "https://example.com/a.zip"} {
		if nothing, err := r.Resolve(ctx, u); nothing != nil || err != nil {
			t.Fatalf("%s: %+v (%v), want nothing", u, nothing, err)
		}
	}
	if _, err := r.Resolve(ctx, "https://tiktok.com/1"); err == nil || !strings.Contains(err.Error(), "not a web address") {
		t.Fatalf("a javascript: address: %v", err)
	}
	if _, err := r.Resolve(ctx, "https://instagram.com/p/1"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("a missing endpoint: %v", err)
	}
	if _, err := r.Resolve(ctx, "https://facebook.com/v/1"); err == nil || !strings.Contains(err.Error(), "unreadable") {
		t.Fatalf("an answer that is not JSON: %v", err)
	}
}

// The page gets a lookup without a file as a miss, with its reason, and never as an error: a
// site's page with nothing behind it or an answer that can't be used, and a service that can't be
// reached. An address that isn't a site's is a file's own, and is no miss.
func TestTheAPISaysWhyThereIsNoFile(t *testing.T) {
	r, _ := standIn(t)
	api := NewAPI(late.Of(r))
	ctx := context.Background()
	if got, err := api.Resolve(ctx, "https://soundcloud.com/a/b"); err != nil || !got.Found || got.Miss != "" || got.Filename != "A track.mp3" {
		t.Errorf("a track: %+v (%v)", got, err)
	}
	for name, u := range map[string]string{
		"nothing behind the page":          "https://youtu.be/1",
		"the service answers with a 404":   "https://instagram.com/p/1",
		"an answer that is not JSON":       "https://facebook.com/v/1",
		"an answer that is not an address": "https://tiktok.com/1",
	} {
		if got, err := api.Resolve(ctx, u); err != nil || got.Found || got.Miss != MissNothing {
			t.Errorf("%s: %+v (%v), want the miss %q", name, got, err, MissNothing)
		}
	}
	if got, err := api.Resolve(ctx, "https://example.com/a.zip"); err != nil || got.Found || got.Miss != "" {
		t.Errorf("a file's own address: %+v (%v), want no miss", got, err)
	}

	// A service that isn't there.
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	away := NewAPI(late.Of(New(http.DefaultClient, gone.URL)))
	if got, err := away.Resolve(ctx, "https://youtu.be/1"); err != nil || got.Found || got.Miss != MissUnreachable {
		t.Errorf("no service: %+v (%v), want the miss %q", got, err, MissUnreachable)
	}
	// The error of a lookup doesn't name the address that was looked up.
	if _, err := New(http.DefaultClient, gone.URL).Resolve(ctx, "https://youtu.be/private-post"); err == nil || strings.Contains(err.Error(), "private-post") {
		t.Errorf("the error names the address: %v", err)
	}
	// The page stops a lookup when its address changes, which is no miss.
	stopped, cancel := context.WithCancel(ctx)
	cancel()
	if got, err := away.Resolve(stopped, "https://youtu.be/1"); err == nil || got.Miss != "" {
		t.Errorf("a stopped lookup: %+v (%v), want its error", got, err)
	}
}
