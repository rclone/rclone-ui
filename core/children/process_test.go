package children

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/logs"
)

// masked reads text the way a rclone child's output is read, and masks the given secrets.
func masked(t *testing.T, text string, secrets ...string) []logs.Record {
	t.Helper()
	var got []logs.Record
	emit := masking(func(e logs.Record) { got = append(got, e) }, secrets...)
	if err := logs.ReadChild(strings.NewReader(text), logs.Stderr, logs.RcloneChild(logs.CompChildren, "test"), emit); err != nil {
		t.Fatal(err)
	}
	return got
}

// TestMaskingAList covers list options. rclone prints each item of a list option quoted, and
// also the variable's quoted CSV record (fs/config/flags/flags.go). None of them may show.
func TestMaskingAList(t *testing.T) {
	const record = `"ak1,sk1","ak2,sk2"`
	var text strings.Builder
	for _, item := range []string{"ak1,sk1", "ak2,sk2"} {
		fmt.Fprintf(&text, "Setting --%s %q from environment variable %s=%q\n", "auth-key", item, "RCLONE_AUTH_KEY", record)
	}
	text.WriteString("nothing secret\n")
	got := masked(t, text.String(), "", "ak1,sk1", "ak2,sk2", record)
	if len(got) != 3 {
		t.Fatalf("%d records", len(got))
	}
	for _, e := range got[:2] {
		if want := `Setting --auth-key "***" from environment variable RCLONE_AUTH_KEY="***"`; e.Message != want {
			t.Errorf("%q, want %q", e.Message, want)
		}
	}
	if got[2].Message != "nothing secret" {
		t.Errorf("a line with no secret: %q", got[2].Message)
	}
}

// TestMaskingEveryForm covers the forms a secret can take. When rclone prints a password with a
// quote or a backslash using %q inside a JSON line, it is escaped twice. The line is decoded
// before masking, and the escaped forms used in URLs are masked too. A line that can't be
// decoded (because it was cut short) is still masked, and so are a panic's text and the tunnel's
// basic auth as cloudflared logs its header. A short password is masked as well.
func TestMaskingEveryForm(t *testing.T) {
	for _, pass := range []string{`p"ss`, `back\slash`, `a&b<c>`, "Zq"} {
		var line bytes.Buffer
		slog.New(slog.NewJSONHandler(&line, nil)).Info(
			fmt.Sprintf("Setting --pass %q from environment variable RCLONE_PASS=%q", pass, pass),
			"url", "https://u:"+url.QueryEscape(pass)+"@h/", "path", "/x/"+url.PathEscape(pass))
		json := strings.TrimSuffix(line.String(), "\n")
		basic := basicAuth("user", pass)
		text := json + "\n" +
			"cut short: " + json + "\n" +
			"GET / Authorization: Basic " + basic + "\n" +
			"panic: wrong password " + pass + "\n\ngoroutine 1 [running]:\nmain.main()\n\tagain " + pass + "\n"
		got := masked(t, text, pass, basic)
		if len(got) != 4 {
			t.Fatalf("%q: %d records", pass, len(got))
		}
		if want := `Setting --pass "***" from environment variable RCLONE_PASS="***"`; got[0].Message != want {
			t.Errorf("%q: %q, want %q", pass, got[0].Message, want)
		}
		if got[0].Extra["url"] != "https://u:***@h/" || got[0].Extra["path"] != "/x/***" {
			t.Errorf("%q: extra %v", pass, got[0].Extra)
		}
		quoted := strconv.Quote(pass)
		for _, e := range got {
			for _, leak := range []string{pass, quoted[1 : len(quoted)-1], basic} {
				if strings.Contains(e.Message, leak) {
					t.Errorf("%q: %q shows in %q", pass, leak, e.Message)
				}
			}
		}
		if !strings.Contains(got[3].Message, "panic: wrong password ***") || !strings.Contains(got[3].Message, "again ***") {
			t.Errorf("%q: the panic's text %q", pass, got[3].Message)
		}
	}
}
