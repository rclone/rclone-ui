// Package metadatamap implements `rcui metadata-map`, the program that rclone's --metadata-mapper
// option runs.
//
// rclone runs it once for each file and directory it copies, possibly several at a time. It
// sends one JSON object on stdin and reads one back from stdout, and only uses its `Metadata`
// field. This is the only way to rename metadata between two backends, so the metadata mapping
// panel points the option at this binary, as in ["metadata-map", "--map", "mtime=modified"]. The
// core adds the path of the running executable in front.
//
// Nothing here touches the data directory, the log or the network. The program is started for
// each object, so it has to stay fast and quiet.
package metadatamap

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"unicode/utf8"
)

// Pair is one `<key>=<value>` argument.
type Pair struct{ Key, Value string }

// Rules says what to do with the metadata of one object. Every rule reads the original input,
// so no rule sees another rule's output. The rules appear on the command line in the order they
// were written in the panel.
type Rules struct {
	// Map renames Key to Value. The old name is removed unless another rule adds it back.
	Map []Pair
	// Set writes a constant value, whatever the source had.
	Set []Pair
	// Drop removes a key from the output, whatever any other rule says.
	Drop []string
	// OnlyMapped keeps only what the rules produced. By default, everything else is kept as is.
	OnlyMapped bool
}

const usage = "usage: rcui metadata-map [--only-mapped] [--map <from>=<to>]… [--set <key>=<value>]… [--drop <key>]…"

// splitPair splits `key=value` on its first `=`, so a value may contain more of them.
func splitPair(flag, arg string) (Pair, error) {
	key, value, ok := strings.Cut(arg, "=")
	if !ok || key == "" {
		return Pair{}, fmt.Errorf("%s expects <key>=<value>, got '%s'", flag, arg)
	}
	return Pair{key, value}, nil
}

// ParseArgs reads the rules from a command line: all the arguments after the subcommand, in
// order.
func ParseArgs(args []string) (Rules, error) {
	var rules Rules
	for i := 0; i < len(args); i++ {
		flag := args[i]
		switch flag {
		case "--only-mapped":
			rules.OnlyMapped = true
			continue
		case "--map", "--set", "--drop":
		default:
			return Rules{}, fmt.Errorf("unknown argument '%s'\n%s", flag, usage)
		}
		if i+1 == len(args) {
			return Rules{}, fmt.Errorf("%s needs a value\n%s", flag, usage)
		}
		i++
		if flag == "--drop" {
			rules.Drop = append(rules.Drop, args[i])
			continue
		}
		pair, err := splitPair(flag, args[i])
		if err != nil {
			return Rules{}, err
		}
		if flag == "--map" {
			rules.Map = append(rules.Map, pair)
		} else {
			rules.Set = append(rules.Set, pair)
		}
	}
	return rules, nil
}

// Apply returns the metadata rclone should write, given what it read from the source. A map
// renames, a set overwrites, and a drop always wins. Values are JSON and are passed through
// unchanged.
func (r Rules) Apply(in map[string]json.RawMessage) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if !r.OnlyMapped {
		for key, value := range in {
			// A renamed field does not keep its old name as well.
			if slices.ContainsFunc(r.Map, func(p Pair) bool { return p.Key == key }) {
				continue
			}
			out[key] = value
		}
	}
	for _, p := range r.Map {
		if value, ok := in[p.Key]; ok {
			out[p.Value] = value
		}
	}
	for _, p := range r.Set {
		out[p.Key] = jsonString(p.Value)
	}
	for _, key := range r.Drop {
		delete(out, key)
	}
	return out
}

func jsonString(s string) json.RawMessage {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s) // a string always encodes
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
}

// Main runs the subcommand. args are the arguments after `metadata-map`. rclone's object is read
// from stdin and the mapped metadata is written to stdout. Main returns the exit code: 2 for a
// bad command line and 3 for input that is not JSON. Errors are written to stderr, which rclone
// copies into its log.
func Main(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	rules, err := ParseArgs(args)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "metadata-map: %v\n", err)
		return 2
	}
	data, err := io.ReadAll(stdin)
	if err == nil && !utf8.Valid(data) {
		err = errors.New("stream did not contain valid UTF-8")
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "metadata-map: could not read rclone's input: %v\n", err)
		return 3
	}
	var object json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		_, _ = fmt.Fprintf(stderr, "metadata-map: rclone's input is not JSON: %v\n", err)
		return 3
	}
	// Any input other than an object with a `Metadata` object counts as no metadata. The rules
	// still run in that case, because `--set` is how a backend without metadata gets some.
	var top map[string]json.RawMessage
	var input map[string]json.RawMessage
	if json.Unmarshal(object, &top) == nil {
		if json.Unmarshal(top["Metadata"], &input) != nil {
			input = nil
		}
	}
	mapped := rules.Apply(input)

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(struct {
		Metadata map[string]json.RawMessage `json:"Metadata"`
	}{mapped}); err != nil {
		_, _ = fmt.Fprintf(stderr, "metadata-map: %v\n", err)
		return 1
	}
	if _, err := stdout.Write(buf.Bytes()); err != nil {
		_, _ = fmt.Fprintf(stderr, "metadata-map: could not write the result: %v\n", err)
		return 1
	}
	return 0
}
