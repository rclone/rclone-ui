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

type Pair struct{ Key, Value string }

type Rules struct {
	Map        []Pair
	Set        []Pair
	Drop       []string
	OnlyMapped bool
}

const usage = "usage: rcui metadata-map [--only-mapped] [--map <from>=<to>]… [--set <key>=<value>]… [--drop <key>]…"

const (
	exitUsage    = 2
	exitBadInput = 3
)

func splitPair(flag, arg string) (Pair, error) {
	key, value, ok := strings.Cut(arg, "=")
	if !ok || key == "" {
		return Pair{}, fmt.Errorf("%s expects <key>=<value>, got '%s'", flag, arg)
	}
	return Pair{key, value}, nil
}

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

func (r Rules) Apply(in map[string]json.RawMessage) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	if !r.OnlyMapped {
		for key, value := range in {
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
	_ = enc.Encode(s)
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
}

func Main(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	rules, err := ParseArgs(args)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "metadata-map: %v\n", err)
		return exitUsage
	}
	data, err := io.ReadAll(stdin)
	if err == nil && !utf8.Valid(data) {
		err = errors.New("stream did not contain valid UTF-8")
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "metadata-map: could not read rclone's input: %v\n", err)
		return exitBadInput
	}
	var object json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		_, _ = fmt.Fprintf(stderr, "metadata-map: rclone's input is not JSON: %v\n", err)
		return exitBadInput
	}
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
