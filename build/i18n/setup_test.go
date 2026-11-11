package main

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// setupFixture is a small rclone module: fs with its own helpers and a common question, a
// constant in fs/config, the sign-in's questions in lib/oauthutil, and a few backends.
var setupFixture = map[string]string{
	"fs/backend_config.go": `package fs

func ConfigInputOptional(state string, name string, help string) (*ConfigOut, error) { return nil, nil }

// A helper that passes its caller's question on is not a question.
func ConfigInput(state string, name string, help string) (*ConfigOut, error) {
	return ConfigInputOptional(state, name, help)
}

func configAll() (*ConfigOut, error) {
	return ConfigConfirm("*all-advanced", false, "config_fs_advanced", "Edit advanced config?")
}
`,
	"fs/config/config.go": `package config

const (
	ConfigClientID = "client_" + configID
	configID       = "id"
)
`,
	"lib/oauthutil/oauthutil.go": `package oauthutil

import (
	"fmt"
	"strings"

	"github.com/rclone/rclone/fs"
)

func ConfigOAuth(state string, newState func(string) string, url string, err error) (*fs.ConfigOut, error) {
	switch state {
	case "*oauth":
		return fs.ConfigConfirm(newState("*oauth-confirm"), true, "config_refresh_token", "Token already configured - replace it?")
	case "*oauth-remote":
		return fs.ConfigInput(newState("*oauth-do"), "config_verification_code", fmt.Sprintf("Go to this URL:\n\n%s\n", url))
	case "*oauth-paste":
		var out strings.Builder
		return fs.ConfigInput(newState("*oauth-authorize"), "config_token", out.String())
	}
	return fs.ConfigError(newState("*oauth-authorize"), fmt.Sprintf("Couldn't decode response: %v\n", err))
}
`,
	"backend/foo/foo.go": `package foo

import (
	"fmt"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
)

const backendName = "foo bar"

const tokenHelp = "Personal " + "login token."

func init() {
	fs.Register(&fs.RegInfo{Name: backendName, Config: Config})
}

func Config(state, dev, kind string, err error, items []fs.OptionExample, other bool) (*fs.ConfigOut, error) {
	switch state {
	case "":
		return fs.ConfigChooseExclusiveFixed("type_done", "config_type", "Type of connection", []fs.OptionExample{{
			Value: "personal",
			Help:  "Personal or Business",
		}, {
			Value: "",
			Help:  "None of these",
		}})
	case "client":
		return fs.ConfigInput("client_set", config.ConfigClientID, "Client "+"Id")
	case "token":
		return fs.ConfigInput("token_set", "config_login_token", tokenHelp)
	case "ok":
		return fs.ConfigConfirm("ok_done", true, "config_ok", fmt.Sprintf("Found %q of type %q\n", dev, kind))
	case "ok_again":
		return fs.ConfigConfirm("ok_done", true, "config_ok", "Is it OK?")
	case "ok_same":
		return fs.ConfigConfirm("ok_done", true, "config_ok", "Is it OK?")
	case "share":
		return fs.ConfigConfirm("share_done", false, "config_share", "Share 100% of it?")
	case "device":
		var help string
		if other {
			help = fmt.Sprintf("The other device %s.", dev)
			return fs.ConfigChoose("device_done", "config_device", help, 0, nil)
		}
		help = fmt.Sprintf("The device %s.", dev)
		return fs.ConfigChoose("device_done", "config_device", help, 0, nil)
	case "branch":
		help := "Which one?"
		if other {
			help = "Which other one?"
		}
		return fs.ConfigInput("branch_done", "config_branch", help)
	case "time":
		return fs.ConfigInput("time_done", "config_time", fmt.Sprintf("Took %5.2f s", 1.5))
	case "phone":
		return fs.ConfigChooseExclusiveFixed("phone_done", "config_phone", "Select a phone", items)
	case "drives":
		return fs.ConfigError("", fmt.Sprintf("Failed to list the drives: %v", err))
	case "none":
		return fs.ConfigError("type", "No drives found")
	}
	return fs.ConfigResult("end", "not shown")
}
`,
	"backend/foo/foo_test.go": `package foo

func ask() { fs.ConfigInput("x", "config_test", "Not read: a test file.") }
`,
	"backend/plain/plain.go": `package plain

import "github.com/rclone/rclone/fs"

func init() { fs.Register(&fs.RegInfo{Name: "plain"}) }
`,
	"backend/twice/twice.go": `package twice

import "github.com/rclone/rclone/fs"

func init() {
	fs.Register(&fs.RegInfo{Name: "one"})
	fs.Register(&fs.RegInfo{Name: "two"})
}

func config() (*fs.ConfigOut, error) { return fs.ConfigInput("x", "config_x", "Which?") }
`,
}

func writeSetupFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for name, text := range setupFixture {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestCollectSetup(t *testing.T) {
	got, err := collectSetup(writeSetupFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		// rclone's common config, with fs's own question. The helpers that pass a question on
		// are not questions.
		k("setup", "question", "config_fs_advanced", "help"):       "Edit advanced config?",
		k("setup", "question", "config_refresh_token", "help"):     "Token already configured - replace it?",
		k("setup", "question", "config_verification_code", "help"): "Go to this URL:\n\n%s\n",
		k("setup", "error", "help"):                                "Couldn't decode response: %v\n",

		// A backend, by the name it registers: a fixed list of choices, a name that is another
		// package's constant, a help that is a constant made of two literals, and a help that is
		// a literal with a "%", which is doubled.
		k("setup", "backend", "foo bar", "question", "config_type", "help"):                         "Type of connection",
		k("setup", "backend", "foo bar", "question", "config_type", "example", "personal", "help"):  "Personal or Business",
		k("setup", "backend", "foo bar", "question", "config_type", "example", "__empty__", "help"): "None of these",
		k("setup", "backend", "foo bar", "question", "client_id", "help"):                           "Client Id",
		k("setup", "backend", "foo bar", "question", "config_login_token", "help"):                  "Personal login token.",
		k("setup", "backend", "foo bar", "question", "config_share", "help"):                        "Share 100%% of it?",
		// The same question with two texts (and one of them twice), in the order of the source:
		// a format and a literal.
		k("setup", "backend", "foo bar", "question", "config_ok", "help"):   "Found %q of type %q\n",
		k("setup", "backend", "foo bar", "question", "config_ok", "help_2"): "Is it OK?",
		// A help in a variable, from the assignment before each call.
		k("setup", "backend", "foo bar", "question", "config_device", "help"):   "The other device %s.",
		k("setup", "backend", "foo bar", "question", "config_device", "help_2"): "The device %s.",
		// A question whose choices can't be read, and the errors.
		k("setup", "backend", "foo bar", "question", "config_phone", "help"): "Select a phone",
		k("setup", "backend", "foo bar", "error", "help"):                    "Failed to list the drives: %v",
		k("setup", "backend", "foo bar", "error", "help_2"):                  "No drives found",
	}
	if keys := got.keys(); !maps.Equal(keys, want) {
		for _, key := range slices.Sorted(maps.Keys(keys)) {
			if want[key] != keys[key] {
				t.Errorf("%s = %q, want %q", strings.ReplaceAll(key, sep, "."), keys[key], want[key])
			}
		}
		for _, key := range slices.Sorted(maps.Keys(want)) {
			if _, ok := keys[key]; !ok {
				t.Errorf("no %s", strings.ReplaceAll(key, sep, "."))
			}
		}
	}

	// Each text that can't be read is named by its file and line.
	unread := strings.Join(got.unread, "\n")
	for _, want := range []string{
		"lib/oauthutil/oauthutil.go:18: the help of config_token can't be read: out.String()",
		// A variable that a branch may have changed.
		"backend/foo/foo.go:", ": the help of config_branch can't be read: help",
		": the help of config_time can't be matched: it uses %5.2f",
		": the choices of config_phone can't be read, because they are made at run time: items",
		"backend/twice: the backend's name can't be read (2 names found), so its questions are skipped",
	} {
		if !strings.Contains(unread, want) {
			t.Errorf("the texts that can't be read lack %q:\n%s", want, unread)
		}
	}
	if len(got.unread) != 5 {
		t.Errorf("%d texts can't be read, want 5:\n%s", len(got.unread), unread)
	}
	if foo := got.scopes["foo bar"]; foo == nil || foo.asked != 10 || foo.shown != 2 {
		t.Errorf("foo bar: %+v", foo)
	}
	if _, ok := got.scopes["plain"]; ok {
		t.Error("a backend that asks nothing has texts")
	}
}

// The registry's text of a common question is kept when the source reads it otherwise, and the
// source adds what the registry lacks.
func TestAddSetup(t *testing.T) {
	live := map[string]string{k("setup", "question", "config_is_local", "help"): "Use web browser?"}
	setup := &setupSource{
		scopes: map[string]*setupTexts{
			"": {questions: map[string][]string{"config_is_local": {"Use a web browser?"}, "config_new": {"New?"}}},
		},
		unread: []string{"lib/x.go:1: the help of config_y can't be read: y"},
	}
	problems := strings.Join(addSetup(live, setup), "\n")
	if live[k("setup", "question", "config_is_local", "help")] != "Use web browser?" || live[k("setup", "question", "config_new", "help")] != "New?" {
		t.Errorf("live is %q", live)
	}
	for _, want := range []string{"rclone's source: lib/x.go:1: the help of config_y can't be read: y", "setup.question.config_is_local.help other texts"} {
		if !strings.Contains(problems, want) {
			t.Errorf("the problems lack %q:\n%s", want, problems)
		}
	}
}

// When rclone swaps a question's two texts, each translation follows its English text to its
// new key.
func TestMergeRcloneMovesATranslationWithItsText(t *testing.T) {
	first := k("setup", "backend", "drive", "question", "config_change_team_drive", "help")
	second := k("setup", "backend", "drive", "question", "config_change_team_drive", "help_2")
	files := map[string]map[string]string{
		"en": {first: "Configure this as a Shared Drive?", second: "Change the Shared Drive %q?"},
		"es": {first: "¿Configurarlo como unidad compartida?", second: "¿Cambiar la unidad compartida %q?"},
	}
	mergeRclone(map[string]string{first: "Change the Shared Drive %q?", second: "Configure this as a Shared Drive?"}, files, false)
	if files["es"][first] != "¿Cambiar la unidad compartida %q?" || files["es"][second] != "¿Configurarlo como unidad compartida?" {
		t.Errorf("es is %q", files["es"])
	}
	// A text that no key had before has no translation.
	mergeRclone(map[string]string{first: "Change the Shared Drive ID %q?", second: "Configure this as a Shared Drive?"}, files, false)
	if _, ok := files["es"][first]; ok {
		t.Errorf("a new text kept a translation: %q", files["es"][first])
	}
}

// A setup question's translation must keep its English format's values, in any order.
func TestReviewRcloneSetupPlaceholders(t *testing.T) {
	dir := t.TempDir()
	ok := k("setup", "backend", "onedrive", "question", "config_drive_ok", "help")
	choice := k("setup", "backend", "onedrive", "question", "config_type", "example", "onedrive", "help")
	files := map[string]map[string]string{
		"en":    {ok: "Found drive %q of type %q", choice: "OneDrive 100% Personal"},
		"es":    {ok: "Unidad %[2]q de tipo %[1]q", choice: "OneDrive 100% personal"},
		"zh-CN": {ok: "找到 drive %q", choice: "OneDrive 100% Personal"},
	}
	for lang, f := range files {
		if err := writeTexts(filepath.Join(dir, "locales", lang, rcloneFile), f); err != nil {
			t.Fatal(err)
		}
	}
	problems, _, err := reviewRclone(dir, []string{"en", "es", "zh-CN"})
	if err != nil {
		t.Fatal(err)
	}
	want := "locales/zh-CN/rclone.json: the translation of setup.backend.onedrive.question.config_drive_ok.help has other placeholders (1:q) than the English (1:q 2:q)"
	if len(problems) != 1 || problems[0] != want {
		t.Errorf("problems %q, want only %q", problems, want)
	}
}

func TestSetupFormat(t *testing.T) {
	for key, want := range map[string]bool{
		k("setup", "error", "help"):                                                              true,
		k("setup", "question", "config_is_local", "help"):                                        true,
		k("setup", "backend", "seafile", "error", "help_2"):                                      true,
		k("setup", "backend", "onedrive", "question", "config_type", "help_12"):                  true,
		k("setup", "confirm", "example", "true", "help"):                                         false,
		k("setup", "backend", "onedrive", "question", "config_type", "example", "error", "help"): false,
		k("setup", "backend", "x", "question", "error", "help"):                                  true,
		k("setup", "backend", "x", "question", "config_type", "description"):                     false,
		k("backend", "local", "option", "nounc", "help"):                                         false,
	} {
		if got := setupFormat(key); got != want {
			t.Errorf("setupFormat(%s) = %v", strings.ReplaceAll(key, sep, "."), got)
		}
	}
}
