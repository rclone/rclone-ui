package logs

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxLine is the longest line of a child's output that is kept whole. The rest of a longer line
// is read and thrown away, and the record says how many bytes were cut.
const MaxLine = 64 << 10

// maxPanic is the most text kept from one Go panic.
const maxPanic = 1 << 20

// ReadLines reads r line by line until it ends. It calls fn with each line, without its line
// ending, and with the number of bytes cut off past MaxLine. It keeps reading until r ends,
// whatever fn does with the lines, so a child never gets stuck while writing. fn must not block.
// ReadLines returns nil at EOF, and the read error otherwise.
func ReadLines(r io.Reader, fn func(line string, cut int)) error {
	br := bufio.NewReaderSize(r, MaxLine+1)
	for {
		chunk, err := br.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			// Cut at a character boundary.
			keep := MaxLine
			for keep > MaxLine-utf8.UTFMax && !utf8.RuneStart(chunk[keep]) {
				keep--
			}
			line := string(chunk[:keep])
			cut := len(chunk) - keep
			for errors.Is(err, bufio.ErrBufferFull) {
				chunk, err = br.ReadSlice('\n')
				cut += len(chunk)
			}
			if bytes.HasSuffix(chunk, []byte("\n")) {
				cut--
			}
			fn(line, cut)
		} else if len(chunk) > 0 {
			fn(strings.TrimSuffix(strings.TrimSuffix(string(chunk), "\n"), "\r"), 0)
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// Stream says which of a child's pipes a line came from.
type Stream int

const (
	Stdout Stream = iota
	Stderr
)

// LineParser turns one line that a child printed into a record. Returning false skips the line.
type LineParser func(line string, stream Stream, now time.Time) (Record, bool)

// panicStart matches the first line of what the Go runtime prints when a program dies: a panic,
// a fatal error, or the dump after a fatal signal.
var panicStart = regexp.MustCompile(`^(panic: |fatal error: |SIG[A-Z]+: )`)

// ReadChild reads one of a child's pipes to the end. It turns each line into a record with
// parse and passes it to emit, which is usually (*Log).Append. A Go panic, including its stack,
// is kept whole in one error record. The panic text runs to the end of the stream, or to the next
// JSON line if the child keeps logging. Blank lines are skipped.
func ReadChild(r io.Reader, stream Stream, parse LineParser, emit func(Record)) error {
	var (
		dying  *Record
		text   strings.Builder
		cutOff int
	)
	endPanic := func() {
		if dying == nil {
			return
		}
		dying.Message = text.String()
		if cutOff > 0 {
			dying.Message += fmt.Sprintf("\n… %d more bytes", cutOff)
		}
		emit(*dying)
		dying, cutOff = nil, 0
		text.Reset()
	}
	err := ReadLines(r, func(line string, cut int) {
		now := time.Now()
		if dying != nil && !isJSONObject(line) {
			if text.Len()+len(line)+1 > maxPanic {
				cutOff += len(line) + 1 + cut
				return
			}
			text.WriteByte('\n')
			text.WriteString(line)
			cutOff += cut
			return
		}
		endPanic()
		if strings.TrimSpace(line) == "" {
			return
		}
		if panicStart.MatchString(line) {
			rec, _ := parse(line, stream, now)
			rec.Level = max(rec.Level, slog.LevelError)
			dying = &rec
			text.WriteString(line)
			cutOff = cut
			return
		}
		rec, ok := parse(line, stream, now)
		if !ok {
			return
		}
		if cut > 0 {
			rec.Message += fmt.Sprintf(" … [line cut: %d more bytes]", cut)
			rec.setExtra(nil, "cut", cut)
		}
		emit(rec)
	})
	endPanic()
	return err
}

func isJSONObject(line string) bool {
	return strings.HasPrefix(strings.TrimSpace(line), "{") && json.Valid([]byte(line))
}

// jsonLine decodes a line that holds a JSON object. ok is false for any other line.
func jsonLine(line string) (map[string]any, bool) {
	if !strings.HasPrefix(strings.TrimSpace(line), "{") {
		return nil, false
	}
	dec := json.NewDecoder(strings.NewReader(line))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil || m == nil {
		return nil, false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, false
	}
	return m, true
}

// take removes key from m and returns its value. It returns "" and leaves m alone when the key
// is missing or its value isn't a string.
func take(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		return ""
	}
	delete(m, key)
	return s
}

// fromJSON makes a record from a decoded JSON line. It reads the level, the time, and the
// message from the first of messageKeys that is present. Everything else goes in Extra.
func fromJSON(m map[string]any, component, subcomponent string, now time.Time, messageKeys ...string) Record {
	rec := Record{Time: now, Level: slog.LevelInfo, Component: component, Subcomponent: subcomponent}
	if s, ok := m["level"].(string); ok {
		if l, ok := levelOf(s); ok {
			rec.Level = l
			delete(m, "level")
		}
	}
	for _, key := range []string{"time", "ts"} {
		if s, ok := m[key].(string); ok {
			if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
				rec.Time = t
				delete(m, key)
				break
			}
		}
	}
	for _, key := range messageKeys {
		if _, ok := m[key].(string); ok {
			rec.Message = take(m, key)
			break
		}
	}
	for k, v := range m {
		rec.setExtra(nil, k, v)
	}
	return rec
}

// RcloneChild parses the lines of one of the app's rclone children, which run with
// --use-json-log. A JSON line keeps its level, message, object, objectType, source and size. Any
// other line is logged as an error: for example, what rclone prints before its logging starts,
// a flag error, or a panic. component and subcomponent are the child's.
func RcloneChild(component, subcomponent string) LineParser {
	return func(line string, _ Stream, now time.Time) (Record, bool) {
		m, ok := jsonLine(line)
		if !ok {
			return Record{Time: now, Level: slog.LevelError, Component: component, Subcomponent: subcomponent, Message: line}, true
		}
		object, objectType, source := take(m, "object"), take(m, "objectType"), take(m, "source")
		var size *int64
		if n, ok := m["size"].(json.Number); ok {
			if v, err := n.Int64(); err == nil {
				size = &v
				delete(m, "size")
			}
		}
		rec := fromJSON(m, component, subcomponent, now, "msg")
		rec.Object, rec.ObjectType, rec.Source, rec.Size = object, objectType, source, size
		return rec, true
	}
}

// PlainLines parses the lines of an external program that has no parser of its own, such as
// cloudflared. A JSON line keeps its level and its message (from msg or message). Any other line
// is logged as info when it comes from stdout, and as an error when it comes from stderr.
func PlainLines(component, subcomponent string) LineParser {
	return func(line string, stream Stream, now time.Time) (Record, bool) {
		if m, ok := jsonLine(line); ok {
			return fromJSON(m, component, subcomponent, now, "msg", "message"), true
		}
		level := slog.LevelInfo
		if stream == Stderr {
			level = slog.LevelError
		}
		return Record{Time: now, Level: level, Component: component, Subcomponent: subcomponent, Message: line}, true
	}
}
