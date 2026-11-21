package metadatamap

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func metadata(t *testing.T, doc string) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(doc), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func equalJSON(t *testing.T, got map[string]json.RawMessage, want string) {
	t.Helper()
	g, _ := json.Marshal(got)
	var a, b any
	_ = json.Unmarshal(g, &a)
	_ = json.Unmarshal([]byte(want), &b)
	if !reflect.DeepEqual(a, b) {
		t.Errorf("got %s, want %s", g, want)
	}
}

func mustParse(t *testing.T, args ...string) Rules {
	t.Helper()
	r, err := ParseArgs(args)
	if err != nil {
		t.Fatalf("ParseArgs(%q): %v", args, err)
	}
	return r
}

func TestTheThreeKindsTogether(t *testing.T) {
	rules := mustParse(t, "--map", "mtime=modified", "--set", "owner=finance", "--drop", "btime")
	out := rules.Apply(metadata(t, `{"mtime": "2026-01-01", "btime": "2020-01-01", "mode": "100644"}`))
	// The mapped field is renamed and its old name is gone, the constant is added, the dropped
	// field is missing, and a field no rule mentions is kept.
	equalJSON(t, out, `{"modified": "2026-01-01", "owner": "finance", "mode": "100644"}`)
}

func TestAMissingSourceWritesNothing(t *testing.T) {
	rules := mustParse(t, "--map", "content-type=mime")
	equalJSON(t, rules.Apply(metadata(t, `{"mode": "100644"}`)), `{"mode": "100644"}`)
}

func TestOnlyMappedKeepsNothingElse(t *testing.T) {
	rules := mustParse(t, "--only-mapped", "--map", "mtime=mtime")
	equalJSON(t, rules.Apply(metadata(t, `{"mtime": "2026-01-01", "uid": "501"}`)), `{"mtime": "2026-01-01"}`)
}

func TestAValueMayContainEqualsSigns(t *testing.T) {
	rules := mustParse(t, "--set", "note=a=b=c")
	if want := []Pair{{"note", "a=b=c"}}; !reflect.DeepEqual(rules.Set, want) {
		t.Errorf("Set = %v, want %v", rules.Set, want)
	}
}

func TestDropBeatsSet(t *testing.T) {
	rules := mustParse(t, "--set", "tier=cold", "--drop", "tier")
	equalJSON(t, rules.Apply(metadata(t, `{}`)), `{}`)
}

func TestParseArgs(t *testing.T) {
	for _, c := range []struct {
		args []string
		want Rules
		err  string
	}{
		{nil, Rules{}, ""},
		{[]string{"--only-mapped"}, Rules{OnlyMapped: true}, ""},
		{
			[]string{"--map", "a=b", "--only-mapped", "--map", "c=", "--set", "k=v", "--drop", "", "--drop", "x"},
			Rules{Map: []Pair{{"a", "b"}, {"c", ""}}, Set: []Pair{{"k", "v"}}, Drop: []string{"", "x"}, OnlyMapped: true},
			"",
		},
		{[]string{"--map", "no-equals-sign"}, Rules{}, "--map expects <key>=<value>, got 'no-equals-sign'"},
		{[]string{"--set", "=value"}, Rules{}, "--set expects <key>=<value>, got '=value'"},
		{[]string{"--nonsense"}, Rules{}, "unknown argument '--nonsense'\n" + usage},
		{[]string{"--map"}, Rules{}, "--map needs a value\n" + usage},
		{[]string{"--drop"}, Rules{}, "--drop needs a value\n" + usage},
		{[]string{"--set", "a=b", "extra"}, Rules{}, "unknown argument 'extra'"},
	} {
		got, err := ParseArgs(c.args)
		if c.err != "" {
			if err == nil || !strings.HasPrefix(err.Error(), c.err) {
				t.Errorf("ParseArgs(%q) error = %v, want %q", c.args, err, c.err)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseArgs(%q) = %+v, %v; want %+v", c.args, got, err, c.want)
		}
	}
}

func TestMainFilter(t *testing.T) {
	for _, c := range []struct {
		name      string
		args      []string
		stdin     string
		code      int
		stdout    string
		stderrHas string
	}{
		{
			"rclone's object in, the mapped metadata out",
			[]string{"--map", "mtime=modified", "--set", "note=<a & b>"},
			`{"SrcFs":"s3:","Metadata":{"mtime":"2026-01-01","mode":"100644","nested":{"a": [1, 2.50]}}}`,
			0,
			`{"Metadata":{"mode":"100644","modified":"2026-01-01","nested":{"a":[1,2.50]},"note":"<a & b>"}}` + "\n",
			"",
		},
		{"no Metadata at all still gets the rules", []string{"--set", "k=v"}, `{"SrcFs":"s3:"}`, 0, `{"Metadata":{"k":"v"}}` + "\n", ""},
		{"a null Metadata", nil, `{"Metadata":null}`, 0, `{"Metadata":{}}` + "\n", ""},
		{"not an object", nil, `[1,2]`, 0, `{"Metadata":{}}` + "\n", ""},
		{"a bad argument", []string{"--nope"}, `{}`, 2, "", "metadata-map: unknown argument '--nope'"},
		{"input that is not JSON", nil, `{"Metadata":`, 3, "", "metadata-map: rclone's input is not JSON:"},
		{"empty input", nil, ``, 3, "", "metadata-map: rclone's input is not JSON:"},
		{"trailing garbage", nil, `{} {}`, 3, "", "not JSON"},
		{"input that is not UTF-8", nil, "{\"Metadata\":{\"a\":\"\xff\"}}", 3, "", "metadata-map: could not read rclone's input: stream did not contain valid UTF-8"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := Main(c.args, strings.NewReader(c.stdin), &stdout, &stderr)
			if code != c.code {
				t.Errorf("code = %d, want %d (stderr %q)", code, c.code, stderr.String())
			}
			if stdout.String() != c.stdout {
				t.Errorf("stdout = %q, want %q", stdout.String(), c.stdout)
			}
			if c.stderrHas == "" && stderr.Len() > 0 || !strings.Contains(stderr.String(), c.stderrHas) {
				t.Errorf("stderr = %q, want %q", stderr.String(), c.stderrHas)
			}
		})
	}
}
