package telemetry

import (
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const (
	// framesMax is the most calls of a stack that are sent.
	framesMax = 60
	// crashRead is the most of crash.log that is read for one report.
	crashRead = 256 << 10
)

// inApp reports whether a Go function is the app's own code, which PostHog shows first.
func inApp(function string) bool {
	return strings.HasPrefix(function, "github.com/rclone/rclone-ui/") || strings.HasPrefix(function, "main.")
}

// sourceFile returns a source file's path without what comes from the computer it was built on.
// A release is built with -trimpath, so its paths start at the module ("core/browse/usage.go" in
// "github.com/rclone/rclone-ui/core/browse/usage.go") and are kept. An absolute path keeps its
// last folder and its name.
func sourceFile(file string) string {
	file = strings.ReplaceAll(file, `\`, "/")
	if !strings.HasPrefix(file, "/") && !(len(file) > 1 && file[1] == ':') {
		return file
	}
	parts := strings.Split(file, "/")
	return strings.Join(parts[max(0, len(parts)-2):], "/")
}

// goFrames reads the first goroutine of a Go traceback, as debug.Stack and a crash write it, into
// frames with the outermost call first. The calls that only report the panic (debug.Stack, the
// deferred function that recovered, and panic itself) are left out, so the last frame is where
// it happened.
//
// A traceback lists each call as two lines, innermost first:
//
//	github.com/rclone/rclone-ui/core/browse.(*UsageTree).add(0x14000..., {0x0, 0x0, 0x0})
//		github.com/rclone/rclone-ui/core/browse/usage.go:201 +0x1c4
func goFrames(trace string) []Frame {
	var frames []Frame
	lines := strings.Split(trace, "\n")
	for i := 0; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r")
		if line == "" {
			if len(frames) > 0 {
				break // the end of the first goroutine
			}
			continue
		}
		if strings.HasPrefix(line, "goroutine ") || strings.HasPrefix(line, "\t") || i+1 >= len(lines) {
			continue
		}
		at := strings.TrimSpace(strings.TrimRight(lines[i+1], "\r"))
		if !strings.HasPrefix(lines[i+1], "\t") {
			continue // not a call: a line of the panic's own text
		}
		function := line
		if rest, ok := strings.CutPrefix(function, "created by "); ok {
			function, _, _ = strings.Cut(rest, " in goroutine ")
		} else if open := strings.LastIndex(function, "("); open > 0 {
			function = function[:open]
		}
		file, lineNo := at, 0
		if space := strings.LastIndex(at, " +0x"); space > 0 {
			file = at[:space]
		}
		if colon := strings.LastIndex(file, ":"); colon > 0 {
			lineNo, _ = strconv.Atoi(file[colon+1:])
			file = file[:colon]
		}
		frames = append(frames, Frame{Function: function, File: sourceFile(file), Line: lineNo})
		i++
	}
	// Everything up to panic itself only reports it.
	for i, f := range frames[:min(len(frames), 8)] {
		if f.Function == "panic" || f.Function == "runtime.gopanic" {
			frames = frames[i+1:]
			break
		}
	}
	if len(frames) > 0 && frames[0].Function == "runtime/debug.Stack" {
		frames = frames[min(len(frames), 2):] // and the function that called it
	}
	frames = frames[:min(len(frames), framesMax)]
	slices.Reverse(frames)
	return frames
}

// The two ways a browser writes a call in an error's stack: WebKit and Firefox as "name@url:1:2",
// and Chromium (WebView2) as "at name (url:1:2)".
var (
	reStackV8     = regexp.MustCompile(`^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$`)
	reStackWebKit = regexp.MustCompile(`^(?:(.*?)@)?(.+?):(\d+):\d+$`)
	reOrigin      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*://[^/]*/`)
)

// scriptFrames reads a page error's stack into frames with the outermost call first. A script is
// named by its path in the app ("assets/index-B2x9.js"), without the address it was loaded from.
func scriptFrames(stack string) []Frame {
	var frames []Frame
	for line := range strings.SplitSeq(stack, "\n") {
		line = strings.TrimRight(line, "\r")
		m := reStackV8.FindStringSubmatch(line)
		if m == nil {
			m = reStackWebKit.FindStringSubmatch(strings.TrimSpace(line))
		}
		if m == nil {
			continue
		}
		file := reOrigin.ReplaceAllString(m[2], "")
		file, _, _ = strings.Cut(file, "?")
		lineNo, _ := strconv.Atoi(m[3])
		function := m[1]
		if function == "" {
			function = "?"
		}
		frames = append(frames, Frame{Function: function, File: file, Line: lineNo, Script: true})
		if len(frames) == framesMax {
			break
		}
	}
	slices.Reverse(frames)
	return frames
}

// crashOf reads a crash from the text that the Go runtime wrote when it ended the app: a panic
// that nothing recovered, a fatal error, or a signal. It returns false when the text holds none.
//
//	panic: runtime error: index out of range [1] with length 1
//
//	goroutine 8 [running]:
//	…
func crashOf(text string) (Crash, bool) {
	text = strings.TrimLeft(text, "\r\n")
	if text == "" {
		return Crash{}, false
	}
	headline, _, _ := strings.Cut(text, "\n")
	headline = strings.TrimSpace(headline)
	c := Crash{Kind: "crash", Message: headline, Source: "crash"}
	if message, ok := strings.CutPrefix(headline, "panic: "); ok {
		c.Kind, c.Message = "panic", strings.TrimSuffix(message, " [recovered]")
	} else if message, ok := strings.CutPrefix(headline, "fatal error: "); ok {
		c.Kind, c.Message = "fatal error", message
	}
	if at := strings.Index(text, "\ngoroutine "); at >= 0 {
		c.Frames = goFrames(text[at+1:])
	}
	return c, true
}

// CrashLog reports the crash that the app's last run left in the file at path (crash.log, which
// the Go runtime writes as it ends the app), if there is one. It remembers how much of the file
// it has read in a file next to it, so each crash is reported once, and a crash from a run in
// which nothing was shared is never sent later.
func (s *Service) CrashLog(path string) {
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	mark := path + ".sent"
	var sent int64
	if b, err := os.ReadFile(mark); err == nil {
		sent, _ = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	}
	size := info.Size()
	if size == sent {
		return
	}
	if size < sent {
		sent = 0 // the file started over
	}
	defer func() { _ = os.WriteFile(mark, []byte(strconv.FormatInt(size, 10)), 0o600) }()
	if client, _ := s.current(); client == nil {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	buf := make([]byte, min(size-sent, crashRead))
	n, _ := f.ReadAt(buf, sent)
	if crash, ok := crashOf(string(buf[:n])); ok {
		s.Report(crash)
	}
}
