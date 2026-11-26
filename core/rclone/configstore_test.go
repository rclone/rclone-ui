package rclone

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/config"

	"github.com/rclone/rclone-ui/core/i18n"
)

func reopen(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		store.OnChange(nil)
		store.OnState(nil)
		if err := store.Open(configPath, ""); err != nil {
			t.Error(err)
		}
	})
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

// touch gives path a distinct mtime, so that a change with the same size is still noticed even
// within the filesystem's time granularity (rclone compares mtime and size).
func touch(t *testing.T, path string, at time.Time) {
	t.Helper()
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func encrypted(t *testing.T, path, password, text string) {
	t.Helper()
	if err := config.SetConfigPassword(password); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	err := config.Encrypt(strings.NewReader(text), &buf)
	config.ClearConfigPassword()
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, buf.String())
}

func TestIsEncryptedAndCheckPassword(t *testing.T) {
	dir := t.TempDir()
	enc, plain, missing := filepath.Join(dir, "enc.conf"), filepath.Join(dir, "plain.conf"), filepath.Join(dir, "none.conf")
	encrypted(t, enc, "pässwörd ﬁle", "[a]\ntype = memory\n")
	writeFile(t, plain, "# a comment\n\n[a]\ntype = memory\n")

	if !IsEncrypted(enc) || IsEncrypted(plain) || IsEncrypted(missing) {
		t.Errorf("IsEncrypted: enc %v plain %v missing %v", IsEncrypted(enc), IsEncrypted(plain), IsEncrypted(missing))
	}
	// The password is NFKC-normalized, as rclone does for its key, so the ligature ﬁ equals fi.
	for _, pw := range []string{"pässwörd ﬁle", "pässwörd file"} {
		if err := CheckPassword(enc, pw); err != nil {
			t.Errorf("CheckPassword(%q) = %v", pw, err)
		}
	}
	if err := CheckPassword(enc, "wrong"); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("a wrong password: %v", err)
	}
	if err := CheckPassword(enc, "   "); err == nil || errors.Is(err, ErrWrongPassword) {
		t.Errorf("a blank password: %v", err)
	}
	if err := CheckPassword(plain, "x"); !errors.Is(err, ErrNotEncrypted) {
		t.Errorf("a plain file: %v", err)
	}
	if err := CheckPassword(missing, "x"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a missing file: %v", err)
	}
	if config.IsEncrypted() {
		t.Error("CheckPassword set rclone's key")
	}

	b, err := os.ReadFile(enc)
	if err != nil {
		t.Fatal(err)
	}
	commented := filepath.Join(dir, "commented.conf")
	writeFile(t, commented, "; saved by hand\n\n"+string(b))
	if !IsEncrypted(commented) || CheckPassword(commented, "pässwörd file") != nil {
		t.Error("a comment before the header")
	}
	v1 := filepath.Join(dir, "v1.conf")
	writeFile(t, v1, "RCLONE_ENCRYPT_V1:\nAAAA\n")
	if IsEncrypted(v1) || CheckPassword(v1, "x") == nil || !strings.Contains(CheckPassword(v1, "x").Error(), "unsupported") {
		t.Errorf("a newer scheme: %v", CheckPassword(v1, "x"))
	}
}

func TestOpenAnEncryptedConfig(t *testing.T) {
	reopen(t)
	dir := t.TempDir()
	enc, plain := filepath.Join(dir, "work.conf"), filepath.Join(dir, "home.conf")
	encrypted(t, enc, "secret", "[work]\ntype = memory\n\n[crypt]\ntype = alias\nremote = work:x\n")
	writeFile(t, plain, "[home]\ntype = memory\n")
	t.Setenv("RCLONE_CONFIG_PASS", "")

	var mu sync.Mutex
	var states []Status
	store.OnState(func(st State) {
		mu.Lock()
		defer mu.Unlock()
		states = append(states, st.Status)
	})
	before, err := os.ReadFile(enc)
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Open(enc, ""); err != nil {
		t.Fatal(err)
	}
	st := store.State()
	if st.Status != StatusNeedsPassword || !st.Encrypted || st.Message != "" || st.Path != enc {
		t.Errorf("without a password: %+v", st)
	}
	if got := config.FileSections(); len(got) != 0 {
		t.Errorf("sections without the password: %v", got)
	}
	config.FileSetValue("new", "type", "memory")
	config.SaveConfig()
	if after, _ := os.ReadFile(enc); !bytes.Equal(after, before) {
		t.Error("a save wrote the file it could not read")
	}
	if st := store.State(); !strings.HasPrefix(i18n.Saved(st.SaveError).String(), "the config file "+enc+" is not loaded") {
		t.Errorf("the refused save: %+v", st)
	}

	if err := store.Open(enc, "nope"); err != nil {
		t.Fatal(err)
	}
	if st := store.State(); st.Status != StatusNeedsPassword || i18n.Saved(st.Message).String() != ErrWrongPassword.Error() || config.IsEncrypted() {
		t.Errorf("a wrong password: %+v, key set %v", st, config.IsEncrypted())
	}

	if err := store.Open(enc, "secret"); err != nil {
		t.Fatal(err)
	}
	if st := store.State(); st.Status != StatusOK || !st.Encrypted || st.SaveError != "" {
		t.Errorf("the right password: %+v", st)
	}
	if got := config.FileSections(); !slices.Equal(got, []string{"work", "crypt"}) {
		t.Errorf("sections %v", got)
	}
	if config.GetConfigPath() != enc || os.Getenv("RCLONE_CONFIG_DIR") != dir {
		t.Errorf("rclone's path %q, RCLONE_CONFIG_DIR %q", config.GetConfigPath(), os.Getenv("RCLONE_CONFIG_DIR"))
	}
	config.FileSetValue("work", "description", "saved")
	config.SaveConfig()
	if !IsEncrypted(enc) || CheckPassword(enc, "secret") != nil {
		t.Error("the save is not encrypted with the password")
	}

	if err := store.Open(plain, "secret"); err != nil {
		t.Fatal(err)
	}
	if st := store.State(); st.Status != StatusOK || st.Encrypted || config.IsEncrypted() {
		t.Errorf("a plain file: %+v, key set %v", st, config.IsEncrypted())
	}
	config.FileSetValue("home", "description", "x")
	config.SaveConfig()
	if IsEncrypted(plain) {
		t.Error("a plain file was saved encrypted")
	}
	if got := config.FileSections(); !slices.Equal(got, []string{"home"}) {
		t.Errorf("sections %v", got)
	}

	mu.Lock()
	defer mu.Unlock()
	if want := []Status{StatusNeedsPassword, StatusNeedsPassword, StatusNeedsPassword, StatusOK, StatusOK}; !slices.Equal(states, want) {
		t.Errorf("state changes %v, want %v", states, want)
	}
}

func TestOpenAFileThatCannotBeRead(t *testing.T) {
	reopen(t)
	dir := t.TempDir()
	broken := filepath.Join(dir, "broken.conf")
	if err := os.Mkdir(broken, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := store.Open(broken, ""); err != nil {
		t.Fatal(err)
	}
	if st := store.State(); st.Status != StatusError || st.Message == "" {
		t.Errorf("state %+v", st)
	}
	if got := config.FileSections(); len(got) != 0 {
		t.Errorf("sections %v", got)
	}

	fresh := filepath.Join(dir, "sub", "new.conf")
	if err := store.Open(fresh, ""); err != nil {
		t.Fatal(err)
	}
	if st := store.State(); st.Status != StatusOK {
		t.Errorf("a new file: %+v", st)
	}
	config.FileSetValue("n", "type", "memory")
	config.SaveConfig()
	if b, err := os.ReadFile(fresh); err != nil || !strings.Contains(string(b), "[n]") {
		t.Errorf("the new file: %q %v", b, err)
	}

	for _, p := range []string{"", os.DevNull, filepath.Join(dir, "notfound")} {
		if err := store.Open(p, ""); err == nil {
			t.Errorf("Open(%q) took rclone's no-file name", p)
		}
	}
	if store.Path() != fresh || config.GetConfigPath() != fresh {
		t.Errorf("a refused Open changed the path: %q %q", store.Path(), config.GetConfigPath())
	}
}

func TestWatch(t *testing.T) {
	reopen(t)
	path := filepath.Join(t.TempDir(), "rclone.conf")
	writeFile(t, path, "[drive]\ntype = drive\ntoken = {\"a\":1}\n\n[crypt]\ntype = crypt\nremote = drive:secret\n\n[other]\ntype = memory\n")
	if err := store.Open(path, ""); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var changes []Change
	store.OnChange(func(c Change) {
		mu.Lock()
		defer mu.Unlock()
		changes = append(changes, c)
	})
	took := func() []Change {
		mu.Lock()
		defer mu.Unlock()
		out := changes
		changes = nil
		return out
	}
	clock := time.Now().Add(-time.Hour)
	edit := func(text string) {
		t.Helper()
		writeFile(t, path, text)
		clock = clock.Add(time.Minute)
		touch(t, path, clock)
	}

	store.Poll()
	if c := took(); len(c) != 0 {
		t.Errorf("an unchanged file: %+v", c)
	}

	edit("[drive]\ntype = drive\ntoken = {\"a\":2}\n\n[crypt]\ntype = crypt\nremote = drive:secret\n\n[other]\ntype = memory\n")
	store.Poll()
	if c := took(); len(c) != 0 {
		t.Errorf("a token-only change: %+v", c)
	}
	if v, _ := config.FileGetValue("drive", "token"); v != `{"a":2}` {
		t.Errorf("the new token not read: %q", v)
	}

	edit("[drive]\ntype = drive\ntoken = {\"a\":2}\nroot_folder_id = x\n\n[crypt]\ntype = crypt\nremote = drive:secret\n\n[added]\ntype = memory\n")
	store.Poll()
	c := took()
	if len(c) != 1 || !slices.Equal(c[0].Sections, []string{"added", "drive", "other"}) {
		t.Errorf("an edit: %+v", c)
	}
	if got := config.FileSections(); !slices.Equal(got, []string{"drive", "crypt", "added"}) {
		t.Errorf("sections after the edit %v", got)
	}

	config.FileSetValue("added", "description", "mine")
	config.SaveConfig()
	store.Poll()
	if c := took(); len(c) != 0 {
		t.Errorf("the core's own save: %+v", c)
	}

	edit("[drive]\ntype = drive\ntoken = {\"a\":2}\nroot_folder_id = y\n\n[crypt]\ntype = crypt\nremote = drive:secret\n\n[added]\ntype = memory\ndescription = mine\n")
	config.FileSetValue("added", "token", "t")
	config.SaveConfig()
	if c := took(); len(c) != 1 || !slices.Equal(c[0].Sections, []string{"drive"}) {
		t.Errorf("an edit read by a save: %+v", c)
	}
	store.Poll()
	if c := took(); len(c) != 0 {
		t.Errorf("reported twice: %+v", c)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	encrypted(t, path, "later", string(b))
	clock = clock.Add(time.Minute)
	touch(t, path, clock)
	t.Setenv("RCLONE_CONFIG_PASS", "")
	store.Poll()
	if st := store.State(); st.Status != StatusNeedsPassword || !st.Encrypted {
		t.Errorf("encrypted outside: %+v", st)
	}
	if c := took(); len(c) != 0 {
		t.Errorf("a change reported for a file that could not be read: %+v", c)
	}
	if err := store.Open(path, "later"); err != nil {
		t.Fatal(err)
	}
	if st := store.State(); st.Status != StatusOK {
		t.Errorf("with the password: %+v", st)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		store.Watch(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch did not end with its context")
	}
}

func watched(t *testing.T, text string) (path string, took func() []Change) {
	t.Helper()
	reopen(t)
	path = filepath.Join(t.TempDir(), "rclone.conf")
	writeFile(t, path, text)
	if err := store.Open(path, ""); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var changes []Change
	store.OnChange(func(c Change) {
		mu.Lock()
		defer mu.Unlock()
		changes = append(changes, c)
	})
	return path, func() []Change {
		mu.Lock()
		defer mu.Unlock()
		out := changes
		changes = nil
		return out
	}
}

func TestPollWaitsOutASaveGap(t *testing.T) {
	const before = "[drive]\ntype = drive\ntoken = {\"a\":1}\n\n[other]\ntype = memory\n"
	path, took := watched(t, before)
	st := store.State()

	aside := path + ".old"
	if err := os.Rename(path, aside); err != nil {
		t.Fatal(err)
	}
	store.Poll()
	if c := took(); len(c) != 0 {
		t.Errorf("the file renamed away: %+v", c)
	}
	if got := config.FileSections(); !slices.Equal(got, []string{"drive", "other"}) {
		t.Errorf("sections in the gap: %v", got)
	}
	if got := store.State(); got != st {
		t.Errorf("state in the gap: %+v, was %+v", got, st)
	}

	next := path + ".new"
	writeFile(t, next, "[drive]\ntype = drive\ntoken = {\"a\":2}\n\n[other]\ntype = memory\n")
	touch(t, next, time.Now().Add(time.Minute))
	if err := os.Rename(next, path); err != nil {
		t.Fatal(err)
	}
	store.Poll()
	if c := took(); len(c) != 0 {
		t.Errorf("the new file renamed in: %+v", c)
	}
	if v, _ := config.FileGetValue("drive", "token"); v != `{"a":2}` {
		t.Errorf("the new token not read: %q", v)
	}
}

func TestPollBelievesAMissingFileOnTheNextLook(t *testing.T) {
	path, took := watched(t, "[drive]\ntype = drive\n\n[other]\ntype = memory\n")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	store.Poll()
	if c := took(); len(c) != 0 {
		t.Errorf("the first look: %+v", c)
	}
	store.Poll()
	if c := took(); len(c) != 1 || !slices.Equal(c[0].Sections, []string{"drive", "other"}) {
		t.Errorf("the second look: %+v", c)
	}
	if got := config.FileSections(); len(got) != 0 {
		t.Errorf("sections of a deleted file: %v", got)
	}
}

func TestChangedSectionsAndTokenKeys(t *testing.T) {
	before := map[string]map[string]string{
		"a": {"type": "drive", "token": "1"},
		"b": {"type": "protondrive", "client_uid": "u", "client_access_token": "t", "username": "me"},
		"c": {"type": "s3"},
	}
	after := map[string]map[string]string{
		"a": {"type": "drive", "token": "2"},
		"b": {"type": "protondrive", "client_uid": "v", "client_access_token": "s", "username": "me"},
		"c": {"type": "s3", "region": "x"},
		"d": {"type": "memory"},
	}
	if got := changedSections(before, after); !slices.Equal(got, []string{"c", "d"}) {
		t.Errorf("changed %v", got)
	}
	if got := changedSections(after, before); !slices.Equal(got, []string{"c", "d"}) {
		t.Errorf("changed back %v", got)
	}
	for k, want := range map[string]bool{
		"token": true, "token_expiry": true, "trust_token": true, "client_refresh_token": true, "cookies": true,
		"tokens": false, "access_key_id": false, "client_id": false, "type": false,
		"bearer_token": false, "session_token": false, "token_url": false,
	} {
		if isTokenKey(k) != want {
			t.Errorf("isTokenKey(%q) = %v", k, !want)
		}
	}
}

// The remote's name has more than one letter, because on Windows rclone reads "w:" as drive W.
func TestUserTokenEditIsAChange(t *testing.T) {
	path, took := watched(t, "[dav]\ntype = webdav\nurl = http://127.0.0.1:9/dav\nvendor = other\nbearer_token = OLD\n")
	ctx := context.Background()
	before, err := cache.Get(ctx, "dav:")
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, "[dav]\ntype = webdav\nurl = http://127.0.0.1:9/dav\nvendor = other\nbearer_token = NEW\n")
	touch(t, path, time.Now().Add(time.Minute))
	store.Poll()
	c := took()
	if len(c) != 1 || !slices.Equal(c[0].Sections, []string{"dav"}) {
		t.Fatalf("the edit of bearer_token: %+v", c)
	}
	for _, name := range c[0].Sections {
		cache.ClearConfig(name)
	}
	after, err := cache.Get(ctx, "dav:")
	if err != nil {
		t.Fatal(err)
	}
	if after == before {
		t.Error("dav: is the same Fs after its bearer_token changed")
	}
}

func TestWrappersOf(t *testing.T) {
	conf := map[string]map[string]string{
		"drive":  {"type": "drive"},
		"crypt":  {"type": "crypt", "remote": "drive:secret"},
		"alias":  {"type": "alias", "remote": "crypt:"},
		"union":  {"type": "union", "upstreams": "/local other:dir drive:photos:ro"},
		"comb":   {"type": "combine", "upstreams": `"a=union:x" "b=/tmp"`},
		"other":  {"type": "s3"},
		"lookal": {"type": "alias", "remote": "mydrive:"},
	}
	cases := []struct {
		in, want []string
	}{
		{[]string{"drive"}, []string{"alias", "comb", "crypt", "drive", "union"}},
		{[]string{"crypt"}, []string{"alias", "crypt"}},
		{[]string{"other"}, []string{"comb", "other", "union"}},
		{[]string{"lookal"}, []string{"lookal"}},
		{[]string{"gone"}, []string{"gone"}},
	}
	for _, c := range cases {
		if got := WrappersOf(conf, c.in); !slices.Equal(got, c.want) {
			t.Errorf("WrappersOf(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestMentions(t *testing.T) {
	names := []string{"drive", "alias"}
	cases := []struct {
		source string
		want   bool
	}{
		{"drive:", true},
		{"drive:photos/2024", true},
		{"drive,shared_with_me:x", true},
		{":union,upstreams='/tmp drive:x':", true},
		{"alias:", true},
		{"other:drive:x", false},
		{"mydrive:x", false},
		{"/Users/me/drive:x", false},
		{"/tmp/x", false},
	}
	for _, c := range cases {
		if got := Mentions(c.source, names); got != c.want {
			t.Errorf("Mentions(%q) = %v, want %v", c.source, got, c.want)
		}
	}
	if Mentions("drive:", nil) {
		t.Error("Mentions with no names is true")
	}
}

func TestDefaultConfigPathIsRclones(t *testing.T) {
	want := filepath.Join(dataDir, "rclone", "rclone.conf")
	if got, err := DefaultConfigPath(); err != nil || got != want {
		t.Errorf("DefaultConfigPath = %q, %v; want %q", got, err, want)
	}
	if got := config.GetConfigPath(); got != configPath {
		t.Errorf("the active config %q, want %q", got, configPath)
	}
}

func TestDefaultConfigInAPortableCopy(t *testing.T) {
	root := t.TempDir()
	conf := filepath.Join(root, "rclone.conf")
	portable := func() (string, bool) { return conf, true }
	installed := func() (string, bool) { return "", false }
	chosen := func() string { return filepath.Join(dataDir, "rclone", "rclone.conf") }

	got, rclones, err := defaultConfig(portable, chosen)
	if err != nil || got != conf || rclones {
		t.Errorf("portable: %q, rclone's own %v, %v; want %q, not rclone's own", got, rclones, err, conf)
	}
	if _, err := os.Stat(conf); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the portable config file was created: %v", err)
	}
	got, rclones, err = defaultConfig(installed, chosen)
	if err != nil || got != chosen() || !rclones {
		t.Errorf("installed: %q, rclone's own %v, %v; want %q, rclone's own", got, rclones, err, chosen())
	}
	if _, _, err := defaultConfig(installed, func() string { return "" }); err == nil {
		t.Error("no config file from rclone was accepted")
	}
}

func TestDefaultIgnoresRCLONE_CONFIG(t *testing.T) {
	other := filepath.Join(t.TempDir(), "team.conf")
	t.Setenv("RCLONE_CONFIG", other)
	got, err := DefaultConfigPath()
	if err != nil || got == other || !filepath.IsAbs(got) {
		t.Fatalf("DefaultConfigPath() = %q, %v with RCLONE_CONFIG=%s", got, err, other)
	}
}

func TestSaveReadsAFileChangedOutside(t *testing.T) {
	reopen(t)
	t.Setenv("RCLONE_CONFIG_PASS", "")
	dir := t.TempDir()
	const text = "[work]\ntype = memory\n"
	outside := func(path, password, text string) {
		t.Helper()
		data := []byte(text)
		if password != "" {
			var err error
			if data, err = EncryptConfig(data, password); err != nil {
				t.Fatal(err)
			}
		}
		writeFile(t, path, string(data))
		touch(t, path, time.Now().Add(time.Minute))
	}
	refresh := func() {
		config.FileSetValue("work", "token", "refreshed")
		config.SaveConfig()
	}
	refused := func(what string) {
		t.Helper()
		if st := store.State(); st.Status != StatusNeedsPassword || !strings.HasPrefix(i18n.Saved(st.SaveError).String(), "the config file ") {
			t.Errorf("%s: state %+v", what, st)
		}
	}

	changed := filepath.Join(dir, "changed.conf")
	encrypted(t, changed, "secret", text)
	if err := store.Open(changed, "secret"); err != nil {
		t.Fatal(err)
	}
	outside(changed, "other", text+"\n[new]\ntype = memory\n")
	refresh()
	if CheckPassword(changed, "other") != nil {
		t.Error("a file whose password changed outside was written over")
	}
	refused("a password changed outside")

	set := filepath.Join(dir, "set.conf")
	writeFile(t, set, text)
	if err := store.Open(set, ""); err != nil {
		t.Fatal(err)
	}
	outside(set, "secret", text)
	refresh()
	if CheckPassword(set, "secret") != nil {
		t.Error("a password set outside was undone")
	}
	refused("a password set outside")

	removed := filepath.Join(dir, "removed.conf")
	encrypted(t, removed, "secret", text)
	if err := store.Open(removed, "secret"); err != nil {
		t.Fatal(err)
	}
	outside(removed, "", text+"\n[other]\ntype = memory\n")
	refresh()
	b, err := os.ReadFile(removed)
	if err != nil {
		t.Fatal(err)
	}
	if s := string(b); IsEncrypted(removed) || !strings.Contains(s, "token = refreshed") || !strings.Contains(s, "[other]") {
		t.Errorf("a file whose password was removed outside was saved as:\n%s", s)
	}
	if st := store.State(); st.Status != StatusOK || st.Encrypted || st.Keyed || st.SaveError != "" || config.IsEncrypted() {
		t.Errorf("after the password was removed outside: %+v, rclone's key set %v", st, config.IsEncrypted())
	}

	edited := filepath.Join(dir, "edited.conf")
	writeFile(t, edited, text)
	if err := store.Open(edited, ""); err != nil {
		t.Fatal(err)
	}
	outside(edited, "", text+"\n[added]\ntype = memory\n")
	refresh()
	if b, err := os.ReadFile(edited); err != nil || !strings.Contains(string(b), "token = refreshed") || !strings.Contains(string(b), "[added]") {
		t.Errorf("a file edited outside was saved as:\n%s (%v)", b, err)
	}
	if st := store.State(); st.Status != StatusOK || st.SaveError != "" {
		t.Errorf("after an edit outside: %+v", st)
	}
}

func TestPollFollowsAPasswordRemovedOutside(t *testing.T) {
	reopen(t)
	t.Setenv("RCLONE_CONFIG_PASS", "")
	path := filepath.Join(t.TempDir(), "work.conf")
	encrypted(t, path, "secret", "[work]\ntype = memory\n")
	if err := store.Open(path, "secret"); err != nil {
		t.Fatal(err)
	}

	writeFile(t, path, "")
	touch(t, path, time.Now().Add(time.Minute))
	store.Poll()
	store.Poll()
	if !store.State().Keyed {
		t.Fatal("an emptied file dropped the key")
	}

	writeFile(t, path, "[work]\ntype = memory\n\n[other]\ntype = memory\n")
	touch(t, path, time.Now().Add(2*time.Minute))
	store.Poll()
	config.FileSetValue("work", "token", "refreshed")
	config.SaveConfig()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if s := string(b); IsEncrypted(path) || !strings.Contains(s, "token = refreshed") || !strings.Contains(s, "[other]") {
		t.Errorf("the core saved:\n%s", s)
	}
	if st := store.State(); st.Status != StatusOK || st.Encrypted || st.Keyed || config.IsEncrypted() {
		t.Errorf("after the save: %+v, rclone's key set %v", st, config.IsEncrypted())
	}
}

func TestCreateEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rclone.conf")
	if err := createEmpty(path); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(path); err != nil || len(b) != 0 {
		t.Fatalf("new file: %q, %v", b, err)
	}
	if err := os.WriteFile(path, []byte("[a]\ntype = local\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createEmpty(path); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != "[a]\ntype = local\n" {
		t.Errorf("an existing file changed: %q", b)
	}
}
