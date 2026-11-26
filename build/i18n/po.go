package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type entry struct {
	comments []string
	notes    []string
	refs     []string
	ctx      string
	id       string
	plural   string
	strs     []string
}

func (e *entry) key() string { return e.ctx + "\x04" + e.id }

func (e *entry) translated() bool {
	if len(e.strs) == 0 {
		return false
	}
	for _, s := range e.strs {
		if s == "" {
			return false
		}
	}
	return true
}

type catalog struct {
	header  []string
	entries []*entry
}

func (c *catalog) find(key string) *entry {
	for _, e := range c.entries {
		if e.key() == key {
			return e
		}
	}
	return nil
}

func (c *catalog) headerValue(name string) string {
	for _, h := range c.header {
		if k, v, ok := strings.Cut(h, ":"); ok && k == name {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func parsePO(text string) (*catalog, error) {
	c := &catalog{}
	cur := &entry{}
	var target *string
	started := false
	flush := func() {
		if !started {
			return
		}
		if cur.id == "" && cur.ctx == "" {
			if len(cur.strs) > 0 {
				for _, line := range strings.Split(strings.TrimSuffix(cur.strs[0], "\n"), "\n") {
					if line != "" {
						c.header = append(c.header, line)
					}
				}
			}
		} else {
			c.entries = append(c.entries, cur)
		}
		cur, target, started = &entry{}, nil, false
	}
	for n, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		quoted := func(s string) (string, error) {
			v, err := strconv.Unquote(strings.TrimSpace(s))
			if err != nil {
				return "", fmt.Errorf("line %d: %s is not a quoted string", n+1, s)
			}
			return v, nil
		}
		var err error
		switch {
		case strings.TrimSpace(line) == "":
			flush()
		case strings.HasPrefix(line, "#~"):
		case strings.HasPrefix(line, "#."):
			cur.notes = append(cur.notes, strings.TrimSpace(line[2:]))
		case strings.HasPrefix(line, "#:"):
			cur.refs = append(cur.refs, strings.TrimSpace(line[2:]))
		case strings.HasPrefix(line, "#,"):
		case strings.HasPrefix(line, "#"):
			cur.comments = append(cur.comments, strings.TrimSpace(line[1:]))
		case strings.HasPrefix(line, "msgctxt "):
			cur.ctx, err = quoted(line[len("msgctxt "):])
			target = &cur.ctx
		case strings.HasPrefix(line, "msgid_plural "):
			cur.plural, err = quoted(line[len("msgid_plural "):])
			target = &cur.plural
		case strings.HasPrefix(line, "msgid "):
			if started {
				flush()
			}
			started = true
			cur.id, err = quoted(line[len("msgid "):])
			target = &cur.id
		case strings.HasPrefix(line, "msgstr["):
			_, rest, ok := strings.Cut(line, "]")
			if !ok {
				return nil, fmt.Errorf("line %d: a msgstr[n] without its ]", n+1)
			}
			var v string
			v, err = quoted(rest)
			cur.strs = append(cur.strs, v)
			target = &cur.strs[len(cur.strs)-1]
		case strings.HasPrefix(line, "msgstr "):
			var v string
			v, err = quoted(line[len("msgstr "):])
			cur.strs = []string{v}
			target = &cur.strs[0]
		case strings.HasPrefix(line, `"`):
			if target == nil {
				return nil, fmt.Errorf("line %d: a string that continues nothing", n+1)
			}
			var v string
			v, err = quoted(line)
			*target += v
		default:
			return nil, fmt.Errorf("line %d: not a PO line: %s", n+1, line)
		}
		if err != nil {
			return nil, err
		}
	}
	flush()
	return c, nil
}

func (c *catalog) String() string {
	var b strings.Builder
	b.WriteString("msgid \"\"\nmsgstr \"\"\n")
	for _, h := range c.header {
		b.WriteString(strconv.Quote(h+"\n") + "\n")
	}
	entries := append([]*entry(nil), c.entries...)
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].key() < entries[j].key() })
	for _, e := range entries {
		b.WriteByte('\n')
		for _, l := range e.comments {
			b.WriteString(strings.TrimRight("# "+l, " ") + "\n")
		}
		for _, l := range e.notes {
			b.WriteString("#. " + l + "\n")
		}
		for _, l := range e.refs {
			b.WriteString("#: " + l + "\n")
		}
		if e.ctx != "" {
			b.WriteString("msgctxt " + quote(e.ctx) + "\n")
		}
		b.WriteString("msgid " + quote(e.id) + "\n")
		if e.plural == "" {
			str := ""
			if len(e.strs) > 0 {
				str = e.strs[0]
			}
			b.WriteString("msgstr " + quote(str) + "\n")
			continue
		}
		b.WriteString("msgid_plural " + quote(e.plural) + "\n")
		for i, s := range e.strs {
			fmt.Fprintf(&b, "msgstr[%d] %s\n", i, quote(s))
		}
	}
	return b.String()
}

func quote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\t", `\t`)
	return `"` + r.Replace(s) + `"`
}
