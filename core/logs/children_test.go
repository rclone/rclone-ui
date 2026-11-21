package logs

import (
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

type readLine struct {
	line string
	cut  int
}

func readAll(t *testing.T, r io.Reader) []readLine {
	t.Helper()
	var got []readLine
	if err := ReadLines(r, func(line string, cut int) { got = append(got, readLine{line, cut}) }); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestReadLines(t *testing.T) {
	long := strings.Repeat("a", MaxLine)
	for _, c := range []struct {
		name  string
		input string
		want  []readLine
	}{
		{"lines", "one\ntwo\r\n\nthree", []readLine{{"one", 0}, {"two", 0}, {"", 0}, {"three", 0}}},
		{"nothing", "", nil},
		{"a line of exactly MaxLine", long + "\nnext\n", []readLine{{long, 0}, {"next", 0}}},
		{"one byte over", long + "b\nnext\n", []readLine{{long, 1}, {"next", 0}}},
		{"far over, and the reading goes on", long + strings.Repeat("c", 3*MaxLine+7) + "\r\nnext\n",
			[]readLine{{long, 3*MaxLine + 8}, {"next", 0}}},
		{"cut at the end of the stream", long + "tail", []readLine{{long, 4}}},
		{"cut on a character boundary", strings.Repeat("a", MaxLine-1) + "é" + "\n",
			[]readLine{{strings.Repeat("a", MaxLine-1), 2}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := readAll(t, strings.NewReader(c.input))
			// Byte by byte, as a pipe may deliver it.
			slow := readAll(t, iotest.OneByteReader(strings.NewReader(c.input)))
			if !reflect.DeepEqual(got, c.want) || !reflect.DeepEqual(slow, c.want) {
				short := func(ls []readLine) []readLine {
					out := make([]readLine, len(ls))
					for i, l := range ls {
						out[i] = readLine{l.line[:min(len(l.line), 20)], l.cut}
					}
					return out
				}
				t.Errorf("got %v / %v, want %v", short(got), short(slow), short(c.want))
			}
		})
	}

	boom := errors.New("pipe broke")
	err := ReadLines(io.MultiReader(strings.NewReader("half"), iotest.ErrReader(boom)), func(string, int) {})
	if !errors.Is(err, boom) {
		t.Errorf("ReadLines error = %v", err)
	}
}

func readChild(t *testing.T, input string, stream Stream, parse LineParser) []Record {
	t.Helper()
	var got []Record
	if err := ReadChild(strings.NewReader(input), stream, parse, func(r Record) { got = append(got, r) }); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestRcloneChildLines(t *testing.T) {
	const panicText = "panic: runtime error: invalid memory address or nil pointer dereference\n" +
		"[signal SIGSEGV: segmentation violation code=0x2 addr=0x0 pc=0x1]\n" +
		"\n" +
		"goroutine 1 [running]:\n" +
		"github.com/rclone/rclone/vfs.(*File).Open(...)\n" +
		"\t/src/vfs/file.go:42 +0x1c"
	input := `{"time":"2026-09-27T10:00:00.123456+02:00","level":"notice","msg":"Serving on :8080","source":"http/server.go:12","pid":42}` + "\n" +
		`{"time":"2026-09-27T10:00:01Z","level":"error","msg":"Failed to copy","object":"dir/file.txt","objectType":"*local.Object","size":1024}` + "\n" +
		"\n" +
		"Error: unknown flag: --nope\n" +
		`{"level":"alert","msg":"no time"}` + "\n" +
		panicText + "\n"

	got := readChild(t, input, Stderr, RcloneChild(CompMounts, "/mnt/data"))
	if len(got) != 5 {
		t.Fatalf("%d records: %+v", len(got), got)
	}
	size := int64(1024)
	for i, want := range []Record{
		{Time: time.Date(2026, 9, 27, 8, 0, 0, 123456000, time.UTC), Level: LevelNotice, Message: "Serving on :8080",
			Source: "http/server.go:12", Extra: map[string]any{"pid": "42"}},
		{Time: time.Date(2026, 9, 27, 10, 0, 1, 0, time.UTC), Level: slog.LevelError, Message: "Failed to copy",
			Object: "dir/file.txt", ObjectType: "*local.Object", Size: &size},
		{Level: slog.LevelError, Message: "Error: unknown flag: --nope"},
		{Level: LevelCritical, Message: "no time"},
		{Level: slog.LevelError, Message: panicText},
	} {
		r := got[i]
		if r.Component != CompMounts || r.Subcomponent != "/mnt/data" {
			t.Errorf("record %d is %s/%s", i, r.Component, r.Subcomponent)
		}
		if !want.Time.IsZero() && !r.Time.Equal(want.Time) {
			t.Errorf("record %d time %v, want %v", i, r.Time, want.Time)
		}
		if r.Time.IsZero() {
			t.Errorf("record %d has no time", i)
		}
		extra := map[string]any{}
		for k, v := range r.Extra {
			extra[k] = strings.Trim(jsonText(v), `"`)
		}
		if len(want.Extra) == 0 {
			want.Extra = map[string]any{}
		}
		if r.Level != want.Level || r.Message != want.Message || r.Source != want.Source || r.Object != want.Object ||
			r.ObjectType != want.ObjectType || !reflect.DeepEqual(r.Size, want.Size) || !reflect.DeepEqual(extra, want.Extra) {
			t.Errorf("record %d = %+v\nwant %+v", i, r, want)
		}
	}
}

func jsonText(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case interface{ String() string }:
		return v.String()
	}
	return ""
}

func TestAPanicEndsAtTheNextJSONLine(t *testing.T) {
	input := "fatal error: concurrent map writes\n\ngoroutine 7 [running]:\nmain.f()\n" +
		`{"level":"info","msg":"still here"}` + "\n"
	got := readChild(t, input, Stdout, RcloneChild(CompServes, "http:127.0.0.1:8080"))
	if len(got) != 2 || got[0].Message != "fatal error: concurrent map writes\n\ngoroutine 7 [running]:\nmain.f()" ||
		got[0].Level != slog.LevelError || got[1].Message != "still here" {
		t.Errorf("records %+v", got)
	}
}

func TestACutLineIsMarked(t *testing.T) {
	input := `{"level":"info","msg":"` + strings.Repeat("x", MaxLine) + "\"}\n"
	got := readChild(t, input, Stderr, RcloneChild(CompMounts, "/m"))
	if len(got) != 1 {
		t.Fatalf("%d records", len(got))
	}
	r := got[0]
	// Cut JSON is no longer valid JSON, so it becomes an error line that reports the cut.
	// There are 23 bytes before the x's and 2 after, so 25 bytes are past MaxLine.
	if r.Level != slog.LevelError || !strings.HasSuffix(r.Message, " … [line cut: 25 more bytes]") || r.Extra["cut"] != 25 {
		t.Errorf("record level %v extra %v message …%s", r.Level, r.Extra, r.Message[len(r.Message)-40:])
	}
}

func TestPlainLines(t *testing.T) {
	stdout := "Thank you for trying Cloudflare Tunnel.\n"
	got := readChild(t, stdout, Stdout, PlainLines(CompTunnel, "cloudflared"))
	if len(got) != 1 || got[0].Level != slog.LevelInfo || got[0].Component != CompTunnel || got[0].Subcomponent != "cloudflared" {
		t.Errorf("stdout records %+v", got)
	}
	stderr := `{"level":"warn","time":"2026-09-27T02:44:26+03:00","message":"Retrying connection","connIndex":0}` + "\n" +
		"failed to parse flags\n"
	got = readChild(t, stderr, Stderr, PlainLines(CompTunnel, "cloudflared"))
	if len(got) != 2 || got[0].Level != slog.LevelWarn || got[0].Message != "Retrying connection" ||
		!got[0].Time.Equal(time.Date(2026, 9, 26, 23, 44, 26, 0, time.UTC)) || got[1].Level != slog.LevelError {
		t.Errorf("stderr records %+v", got)
	}
}

func TestChildLinesReachTheLog(t *testing.T) {
	l, stderr := openTest(t, "warning", tuningFor(t))
	input := `{"level":"info","msg":"quiet"}` + "\n" + `{"level":"error","msg":"loud","object":"x"}` + "\n"
	if err := ReadChild(strings.NewReader(input), Stderr, RcloneChild(CompMounts, "/mnt"), l.Append); err != nil {
		t.Fatal(err)
	}
	closeTest(t, l)
	got := lines(fileRecords(t, l.Path()))
	if len(got) != 2 || got[0].Message != "quiet" || got[1].Object != "x" || got[1].Component != CompMounts {
		t.Errorf("records %+v", got)
	}
	if text := stderr.String(); strings.Contains(text, "quiet") || !strings.Contains(text, "loud") {
		t.Errorf("stderr %s", text)
	}
}
