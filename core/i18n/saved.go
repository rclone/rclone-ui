package i18n

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// A message that is saved (a transfer's error, a schedule's last error) may be shown months
// later, in another language than the app had when it happened. Save writes a Text with its
// English message and its values, and Saved reads it back as a Text, which is then shown in the
// language of the day. Anything else, such as rclone's own error, is saved as its plain words.

// savedMark starts a saved Text. No message starts with this control character.
const savedMark = "\x1e"

type savedText struct {
	Format string `json:"f"`
	Ctx    string `json:"c,omitempty"`
	Plural string `json:"p,omitempty"`
	N      int    `json:"n,omitempty"`
	Args   []any  `json:"a,omitempty"`
}

// savedArg is a value that is itself a Text.
type savedArg struct {
	Text *savedText `json:"t"`
}

// Save returns err's message in the form to save. An error whose message is a Text keeps its
// English message and its values, so that Saved can translate it later. Any other error is
// saved as its words. A nil error gives "".
func Save(err error) string {
	if err == nil {
		return ""
	}
	var t Texter
	if errors.As(err, &t) && sameMessage(err, t) {
		return SaveText(t.Text())
	}
	return err.Error()
}

// SaveText returns t in the form to save, which Saved reads back. Plain words are saved as
// they are.
func SaveText(t Text) string {
	if t.IsZero() {
		return ""
	}
	if t.words {
		return t.format
	}
	b, err := json.Marshal(t.saved())
	if err != nil {
		return t.String()
	}
	return savedMark + string(b)
}

func (t Text) saved() *savedText {
	s := &savedText{Format: t.format, Ctx: t.ctx, Plural: t.plural, N: t.n}
	for _, a := range t.args {
		switch v := a.(type) {
		case Text:
			if v.words {
				s.Args = append(s.Args, v.format)
				continue
			}
			s.Args = append(s.Args, savedArg{v.saved()})
		case error:
			var tx Texter
			if errors.As(v, &tx) && sameMessage(v, tx) {
				s.Args = append(s.Args, savedArg{tx.Text().saved()})
			} else {
				s.Args = append(s.Args, v.Error())
			}
		case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64, bool, string:
			s.Args = append(s.Args, v)
		default:
			// Any other value is saved as fmt would print it.
			s.Args = append(s.Args, fmt.Sprint(v))
		}
	}
	return s
}

// Saved reads what Save or SaveText wrote. Plain words, which is what any other error was saved
// as, give a Text that shows those words in every language.
func Saved(s string) Text {
	rest, ok := strings.CutPrefix(s, savedMark)
	if !ok {
		return plain(s)
	}
	var st savedText
	dec := json.NewDecoder(strings.NewReader(rest))
	dec.UseNumber()
	if err := dec.Decode(&st); err != nil || st.Format == "" {
		return plain(s)
	}
	return st.text()
}

func plain(words string) Text { return Plain(words) }

func (s *savedText) text() Text {
	t := Text{format: s.Format, ctx: s.Ctx, plural: s.Plural, n: s.N}
	for _, a := range s.Args {
		switch v := a.(type) {
		case map[string]any:
			// A nested Text, which the decoder gives as a map: read it again as one.
			if b, err := json.Marshal(v["t"]); err == nil {
				var inner savedText
				dec := json.NewDecoder(strings.NewReader(string(b)))
				dec.UseNumber()
				if dec.Decode(&inner) == nil && inner.Format != "" {
					t.args = append(t.args, inner.text())
					continue
				}
			}
			t.args = append(t.args, "")
		case json.Number:
			// A whole number is an int again, so that %d formats it.
			if i, err := v.Int64(); err == nil {
				t.args = append(t.args, int(i))
			} else if f, err := v.Float64(); err == nil {
				t.args = append(t.args, f)
			} else {
				t.args = append(t.args, v.String())
			}
		default:
			t.args = append(t.args, v)
		}
	}
	return t
}
