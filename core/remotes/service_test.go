package remotes

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/rclone/rclone/backend/alias"
	_ "github.com/rclone/rclone/backend/jottacloud"
	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/memory"
	_ "github.com/rclone/rclone/backend/seafile"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/obscure"
	"github.com/rclone/rclone/fs/rc"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/internal/testdb"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/rclone"
)

var (
	store      *rclone.Store
	configPath string
)

func TestMain(m *testing.M) {
	testutil.Main(m, func(dir string) error {
		configPath = filepath.Join(dir, "rclone.conf")
		if err := os.WriteFile(configPath, nil, 0o600); err != nil {
			return err
		}
		var err error
		store, err = rclone.Init(context.Background(), rclone.InitOptions{ConfigPath: configPath, CacheDir: filepath.Join(dir, "cache")})
		return err
	})
}

// runner runs the service's background work until the test ends.
func runner(t *testing.T) syncx.Runner {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return syncx.RunnerFunc(func(_ string, fn func(context.Context)) { go fn(ctx) })
}

// follower is a Follower that calls its function.
type follower func(ctx context.Context, old, new string) error

func (f follower) RenameRemote(ctx context.Context, old, new string) error { return f(ctx, old, new) }

// noUnlocks is a config file that is never unlocked.
type noUnlocks struct{}

func (noUnlocks) OnUnlocked(func()) {}

// noListings is a listings cache with nothing to drop.
type noListings struct{}

func (noListings) InvalidateRemotes([]string) {}

// setup gives the test its own config text and a started service that uses it. tweak changes
// the service's options before it is created.
func setup(t *testing.T, text string, tweak ...func(*Options)) (*Service, *bus.Sub) {
	t.Helper()
	if err := os.WriteFile(configPath, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Open(configPath, ""); err != nil {
		t.Fatal(err)
	}
	b := bus.New()
	sub := b.Subscribe()
	t.Cleanup(sub.Close)
	o := Options{
		DB: testdb.Open(t), Store: store, Bus: b, Run: runner(t), Config: noUnlocks{},
		Invalidator: noListings{}, Edited: func([]string) {},
	}
	for _, fn := range tweak {
		fn(&o)
	}
	s := New(o)
	s.Start(context.Background())
	return s, sub
}

// waitEvent waits for an event named name.
func waitEvent(t *testing.T, sub *bus.Sub, name string) bus.Event {
	t.Helper()
	timeout := time.After(20 * time.Second)
	for {
		select {
		case ev := <-sub.C:
			if ev.Name == name {
				return ev
			}
		case <-timeout:
			t.Fatalf("no %s event", name)
		}
	}
}

func TestListRowsAndFsinfo(t *testing.T) {
	s, sub := setup(t, "[b]\ntype = memory\n\n[a]\ntype = memory\n\n[notaremote]\nkey = v\n")
	list, err := s.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, r := range list {
		names = append(names, r.Name)
		if r.Type != "memory" {
			t.Errorf("remote %+v", r)
		}
	}
	if !slices.Equal(names, []string{"b", "a"}) {
		t.Errorf("names %v (config order, remotes only)", names)
	}
	// The fsinfo arrives in the background.
	waitEvent(t, sub, bus.RemotesChanged)
	testutil.Eventually(t, 10*time.Second, "the fsinfo", func() bool {
		list, _ = s.List(context.Background())
		return list[0].FSInfo != nil && list[1].FSInfo != nil
	})
	if len(list[0].FSInfo.Hashes) == 0 {
		t.Errorf("fsinfo %+v", list[0].FSInfo)
	}
}

// session runs a config session to its end.
func runSession(t *testing.T, s *Service, sub *bus.Sub, req StartRequest) Step {
	t.Helper()
	st, err := s.Sessions().Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	for {
		cur := s.Sessions().Current(context.Background())
		if cur != nil && cur.ID == st.ID {
			switch cur.State {
			case StateDone, StateFailed, StateCancelled, StateQuestion:
				return *cur
			}
		}
		waitEvent(t, sub, bus.RemotesSession)
	}
}

func TestCreateEditCancel(t *testing.T) {
	s, sub := setup(t, "")
	if problem := s.CheckName("x"); problem == nil {
		t.Error("a one-letter name was accepted")
	}
	st := runSession(t, s, sub, StartRequest{Kind: KindCreate, Name: "store", Type: "alias", Values: map[string]any{"remote": "/tmp"}})
	if st.State != StateDone || st.Result == nil || st.Result.Name != "store" {
		t.Fatalf("create: %+v", st)
	}
	if typ, values, err := s.Values("store"); err != nil || typ != "alias" || values["remote"] != "/tmp" {
		t.Fatalf("values %s %v %v", typ, values, err)
	}
	if b, _ := os.ReadFile(configPath); !strings.Contains(string(b), "[store]") {
		t.Errorf("not saved in the file:\n%s", b)
	}
	// An edit sends only the changed keys, and a rename happens in the same session.
	st = runSession(t, s, sub, StartRequest{Kind: KindUpdate, Name: "store", NewName: "archive", Values: map[string]any{"remote": "/var"}})
	if st.State != StateDone || st.Result.Name != "archive" {
		t.Fatalf("edit: %+v", st)
	}
	if _, values, err := s.Values("archive"); err != nil || values["remote"] != "/var" {
		t.Errorf("edited %v %v", values, err)
	}
	if _, _, err := s.Values("store"); !errors.Is(err, ErrNotFound) {
		t.Errorf("the old name is still there: %v", err)
	}
	// A create that uses an existing name is refused before rclone overwrites the remote.
	if _, err := s.Sessions().Start(context.Background(), StartRequest{Kind: KindCreate, Name: "archive", Type: "memory"}); err == nil {
		t.Error("a clashing create started")
	}
}

// TestRenameThatCannotSave checks that a rename whose config save fails changes nothing. The old
// name keeps its values and its app data, the new name doesn't exist, and the hooks don't run.
func TestRenameThatCannotSave(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a read-only folder still takes new files on Windows")
	}
	ctx := context.Background()
	hooked := false
	s, _ := setup(t, "[photos]\ntype = memory\n", func(o *Options) {
		o.Followers = []Follower{follower(func(context.Context, string, string) error {
			hooked = true
			return nil
		})}
	})
	if _, err := s.List(ctx); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(configPath)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(dir, 0o700) }()
	if _, err := s.rename(ctx, "photos", "pictures"); err == nil {
		t.Fatal("renamed without saving")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if !s.exists("photos") || s.exists("pictures") || s.section("photos")["type"] != "memory" || hooked {
		t.Fatalf("after the failed rename: photos %v, pictures %v, hooked %v", s.exists("photos"), s.exists("pictures"), hooked)
	}
	var rows int
	if err := s.db.Read(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `SELECT count(*) FROM remote_fsinfo WHERE remote = 'photos'`).Scan(&rows)
	}); err != nil || rows != 1 {
		t.Fatalf("the remote's row: %d (%v)", rows, err)
	}
}

// TestRenameThatTheStoreRefuses checks that a rename fails when the store refuses its save,
// because the file changed outside the app and can't be read. The followers aren't told.
func TestRenameThatTheStoreRefuses(t *testing.T) {
	ctx := context.Background()
	hooked := false
	s, _ := setup(t, "[photos]\ntype = memory\n", func(o *Options) {
		o.Followers = []Follower{follower(func(context.Context, string, string) error {
			hooked = true
			return nil
		})}
	})
	if _, err := s.List(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("RCLONE_ENCRYPT_V0:\nnot a config"), 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(configPath, later, later); err != nil {
		t.Fatal(err)
	}
	if _, err := s.rename(ctx, "photos", "pictures"); err == nil {
		t.Fatal("renamed without saving")
	}
	if hooked {
		t.Error("the followers were told")
	}
}

func TestRenameCarriesAndHooks(t *testing.T) {
	ctx := context.Background()
	var hooked []string
	s, _ := setup(t, "[photos]\ntype = memory\n\n[wrap]\ntype = alias\nremote = photos:dir\n", func(o *Options) {
		o.Followers = []Follower{follower(func(_ context.Context, old, new string) error {
			hooked = append(hooked, old+"→"+new)
			return &location.NotRewrittenError{Items: []error{errors.New("a thing: because")}}
		})}
	})
	if _, err := s.List(ctx); err != nil {
		t.Fatal(err)
	}
	res, err := s.rename(ctx, "photos", "pictures")
	if err != nil {
		t.Fatal(err)
	}
	if res.Name != "pictures" || len(res.NotRewritten) != 1 || res.NotRewritten[0].Error() != "a thing: because" || !slices.Equal(hooked, []string{"photos→pictures"}) {
		t.Errorf("result %+v hooked %v", res, hooked)
	}
	list, _ := s.List(ctx)
	if list[len(list)-1].Name != "pictures" && list[0].Name != "pictures" {
		t.Errorf("list %+v", list)
	}
	if _, err := s.rename(ctx, "pictures", "wrap"); err == nil {
		t.Error("a rename onto an existing name")
	}
	if err := s.Delete(ctx, "pictures"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "pictures"); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleting twice: %v", err)
	}
}

// TestEdited checks that Options.Edited gets the remotes that changed with their wrappers, after
// a change, a rename and a delete.
func TestEdited(t *testing.T) {
	ctx := context.Background()
	var got [][]string
	s, _ := setup(t, "[photos]\ntype = memory\n\n[wrap]\ntype = alias\nremote = photos:dir\n\n[other]\ntype = memory\n", func(o *Options) {
		o.Edited = func(names []string) { got = append(got, names) }
	})
	if _, err := s.List(ctx); err != nil {
		t.Fatal(err)
	}
	got = nil
	s.Changed([]string{"photos"})
	if len(got) != 1 || !slices.Equal(got[0], []string{"photos", "wrap"}) {
		t.Fatalf("after a change: %v", got)
	}
	if _, err := s.rename(ctx, "other", "others"); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !slices.Contains(got[1], "other") || !slices.Contains(got[1], "others") {
		t.Fatalf("after a rename: %v", got)
	}
	if err := s.Delete(ctx, "others"); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || !slices.Equal(got[2], []string{"others"}) {
		t.Fatalf("after a delete: %v", got)
	}
}

func TestHealth(t *testing.T) {
	s, sub := setup(t, "[ok]\ntype = memory\n\n[broken]\ntype = alias\nremote = /definitely/not/here\n")
	first := s.Health(context.Background())
	if first["ok"].State != HealthChecking {
		t.Errorf("first answer %+v", first)
	}
	got := map[string]string{}
	for len(got) < 2 {
		ev := waitEvent(t, sub, bus.RemotesHealth)
		he := ev.Data.(bus.RemotesHealthData)
		got[he.ID] = he.State
	}
	if got["ok"] != HealthOK || got["broken"] != HealthFaulty {
		t.Errorf("health %v", got)
	}
	if h := s.Health(context.Background()); h["ok"].State != HealthOK {
		t.Errorf("cached %+v", h["ok"])
	}
}

// TestHealthRecheckOfACheckInFlight checks a recheck of a remote whose earlier check is still
// running, because the backend outlived the timeout. The recheck waits for that check and then
// runs. It doesn't stay stuck in checking after every worker has exited.
func TestHealthRecheckOfACheckInFlight(t *testing.T) {
	s, sub := setup(t, "[hung]\ntype = memory\n")
	h := s.health
	h.mu.Lock()
	h.inflight["hung"] = true
	h.mu.Unlock()
	s.Recheck()
	testutil.Eventually(t, 10*time.Second, "the workers gone, the recheck queued", func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return h.workers == 0 && h.queued["hung"]
	})
	h.done("hung") // the hung call finally returns
	ev := waitEvent(t, sub, bus.RemotesHealth)
	if he := ev.Data.(bus.RemotesHealthData); he.ID != "hung" || he.State != HealthOK {
		t.Fatalf("health %+v", he)
	}
}

func TestOutsideEditReachesPages(t *testing.T) {
	s, sub := setup(t, "[one]\ntype = memory\n")
	store.OnChange(func(c rclone.Change) { s.Changed(c.Sections) })
	t.Cleanup(func() { store.OnChange(nil) })
	if err := os.WriteFile(configPath, []byte("[one]\ntype = memory\n\n[two]\ntype = memory\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Minute)
	_ = os.Chtimes(configPath, future, future)
	store.Poll()
	ev := waitEvent(t, sub, bus.RemotesChanged)
	if data, ok := ev.Data.(bus.RemotesChangedData); !ok || !slices.Contains(data.Names, "two") {
		t.Errorf("event %+v", ev)
	}
}

func TestClaims(t *testing.T) {
	s, _ := setup(t, "")
	if c := s.Claims().Claim("drive", "Commander"); !c.Granted {
		t.Fatal("first claim refused")
	}
	if c := s.Claims().Claim("drive", "Settings"); c.Granted || c.Holder != "Commander" {
		t.Errorf("second claim %+v", c)
	}
	s.Claims().Release("drive", "Commander")
	if c := s.Claims().Claim("drive", "Settings"); !c.Granted {
		t.Error("after the release")
	}
}

// TestQuestionAndCancel checks that a create that asks one question at a time stops at rclone's
// first question, returned as the catalog's option. A cancel then removes the section that
// rclone had written.
func TestQuestionAndCancel(t *testing.T) {
	s, sub := setup(t, "")
	st := runSession(t, s, sub, StartRequest{Kind: KindCreate, Name: "jotta", Type: "jottacloud", NonInteractive: true})
	if st.State != StateQuestion || st.Question == nil || st.Question.Name != "config_type" || st.Type != "jottacloud" {
		t.Fatalf("step %+v", st)
	}
	wire := stepView(&st)
	if q := wire.Question; q == nil || q.Name != "config_type" || len(q.Choices) != 3 || q.Choices[0].Value != "standard" || !q.Exclusive {
		t.Errorf("question %+v", wire.Question)
	}
	if !s.exists("jotta") {
		t.Fatal("rclone wrote no section before asking")
	}
	// The create's own section doesn't make its name taken while it runs.
	if problem := s.CheckName("jotta"); problem != nil {
		t.Errorf("the create's own name is taken: %s", problem)
	}
	if err := s.Sessions().Cancel(context.Background(), st.ID); err != nil {
		t.Fatal(err)
	}
	testutil.Eventually(t, 10*time.Second, "the unfinished remote to go", func() bool { return !s.exists("jotta") })
}

// TestCreatedNameIsTaken checks that a name is taken once its create is done.
func TestCreatedNameIsTaken(t *testing.T) {
	s, sub := setup(t, "")
	st := runSession(t, s, sub, StartRequest{Kind: KindCreate, Name: "store", Type: "alias", Values: map[string]any{"remote": "/tmp"}})
	if st.State != StateDone {
		t.Fatalf("create: %+v", st)
	}
	if problem := s.CheckName("store"); problem == nil {
		t.Error("a created remote's name is free")
	}
}

// TestSessionThatCannotSave checks that a session fails when its remote can't be saved, rather
// than reporting done while the change exists only in memory. A create's section is removed.
func TestSessionThatCannotSave(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a read-only folder still takes new files on Windows")
	}
	ci := fs.GetConfig(context.Background())
	retries := ci.LowLevelRetries
	ci.LowLevelRetries = 0 // rclone's SaveConfig would retry for seconds
	defer func() { ci.LowLevelRetries = retries }()
	s, sub := setup(t, "[photos]\ntype = memory\n")
	dir := filepath.Dir(configPath)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(dir, 0o700) }()
	st := runSession(t, s, sub, StartRequest{Kind: KindCreate, Name: "store", Type: "alias", Values: map[string]any{"remote": "/tmp"}})
	if st.State != StateFailed || !strings.HasPrefix(fmt.Sprint(st.Error), "The remote could not be saved: ") {
		t.Fatalf("create: %+v", st)
	}
	testutil.Eventually(t, 10*time.Second, "the unsaved remote to go", func() bool { return !s.exists("store") })
	st = runSession(t, s, sub, StartRequest{Kind: KindUpdate, Name: "photos", Values: map[string]any{"description": "x"}})
	if st.State != StateFailed || !strings.HasPrefix(fmt.Sprint(st.Error), "The remote could not be saved: ") {
		t.Fatalf("edit: %+v", st)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
}

// TestReconnectAsksJottacloud checks that a reconnect of a provider that is configured one
// question at a time asks its questions, starting with rclone's default (no config_* answer is
// stored). Answering them with their defaults would point the remote somewhere else. A cancel
// leaves the remote as it was.
func TestReconnectAsksJottacloud(t *testing.T) {
	s, sub := setup(t, "[jotta]\ntype = jottacloud\ndevice = Mine\nmountpoint = Sync\n"+
		`token = {"access_token":"a","token_type":"Bearer","refresh_token":"r","expiry":"2030-01-01T00:00:00Z"}`+"\n")
	st := runSession(t, s, sub, StartRequest{Kind: KindReconnect, Name: "jotta"})
	if st.State != StateQuestion || st.Question == nil || st.Question.Name != "config_type" || fmt.Sprint(st.Question.Default) != "standard" {
		t.Fatalf("step %+v", st)
	}
	// The backend comes from the remote's section.
	if st.Type != "jottacloud" {
		t.Errorf("the step's backend is %q", st.Type)
	}
	if err := s.Sessions().Cancel(context.Background(), st.ID); err != nil {
		t.Fatal(err)
	}
	testutil.Eventually(t, 10*time.Second, "the session to end", func() bool {
		cur := s.Sessions().Current(context.Background())
		return cur == nil || cur.State == StateCancelled
	})
	if _, values, err := s.Values("jotta"); err != nil || values["device"] != "Mine" || values["mountpoint"] != "Sync" {
		t.Errorf("after the cancel: %v %v", values, err)
	}
}

func init() {
	// A backend whose config asks which drive to use, as OneDrive's does. rclone stores the
	// choice under a different name from the question's.
	fs.Register(&fs.RegInfo{
		Name: "pickdrive", Description: "a backend that asks which drive",
		NewFs: func(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
			return nil, fs.ErrorNotImplemented
		},
		Config: func(ctx context.Context, name string, m configmap.Mapper, in fs.ConfigIn) (*fs.ConfigOut, error) {
			switch in.State {
			case "":
				return fs.ConfigChooseExclusiveFixed("pick_done", "config_pick", "Which drive?", []fs.OptionExample{{Value: "first"}, {Value: "second"}})
			case "pick_done":
				m.Set("pick", in.Result)
			}
			return nil, nil
		},
		Options: []fs.Option{{Name: "pick", Help: "the drive"}},
	})
}

// TestReconnectKeepsTheAnsweredChoice checks that a reconnect that asks one question at a time
// asks for the drive again, and saves the answer.
func TestReconnectKeepsTheAnsweredChoice(t *testing.T) {
	s, sub := setup(t, "[fk]\ntype = pickdrive\npick = second\n")
	st := runSession(t, s, sub, StartRequest{Kind: KindReconnect, Name: "fk", NonInteractive: true})
	if st.State != StateQuestion || st.Question == nil || st.Question.Name != "config_pick" {
		t.Fatalf("step %+v", st)
	}
	if err := s.Sessions().Answer(context.Background(), st.ID, "second"); err != nil {
		t.Fatal(err)
	}
	for {
		cur := s.Sessions().Current(context.Background())
		if cur != nil && cur.ID == st.ID && cur.State != StateWorking {
			if cur.State != StateDone {
				t.Fatalf("after the answer: %+v", cur)
			}
			break
		}
		waitEvent(t, sub, bus.RemotesSession)
	}
	if _, values, err := s.Values("fk"); err != nil || values["pick"] != "second" {
		t.Errorf("pick %q %v", values["pick"], err)
	}
}

// configGroups returns the stats groups of config sessions that rclone holds.
func configGroups(t *testing.T) []string {
	t.Helper()
	out, err := rc.Calls.Get("core/group-list").Fn(context.Background(), rc.Params{})
	if err != nil {
		t.Fatal(err)
	}
	var groups []string
	all, _ := out["groups"].([]string)
	for _, g := range all {
		if strings.HasPrefix(g, rclone.UIGroup("config", "")) {
			groups = append(groups, g)
		}
	}
	return groups
}

// TestSessionJobGroup checks that a session's call to rclone is counted in its own stats group,
// which is deleted once the session ends.
func TestSessionJobGroup(t *testing.T) {
	waiting, release := armSlowLogin(t)
	defer close(release)
	s, _ := setup(t, "")
	ss := s.Sessions()
	st, err := ss.Start(context.Background(), StartRequest{Kind: KindCreate, Name: "drive", Type: "slowlogin"})
	if err != nil {
		t.Fatal(err)
	}
	<-waiting
	want := rclone.UIGroup("config", st.ID)
	var group string
	// The session gets its job once rclone has accepted the call, which may be after the login
	// began.
	testutil.Eventually(t, 10*time.Second, "the session's job", func() bool {
		ss.mu.Lock()
		defer ss.mu.Unlock()
		if ss.cur.job != nil {
			group = ss.cur.job.Group
		}
		return group != ""
	})
	if got := configGroups(t); group != want || !slices.Equal(got, []string{want}) {
		t.Errorf("the job's group is %q, rclone has %v; want %s", group, got, want)
	}
	if err := ss.Cancel(context.Background(), st.ID); err != nil {
		t.Fatal(err)
	}
	testutil.Eventually(t, 10*time.Second, "the session's group to go", func() bool { return len(configGroups(t)) == 0 })
}

// TestListenerBusy checks that when rclone's sign-in listener fails on a taken port, the address
// is named, however deeply rclone wrapped the error. Any other failure names nothing.
func TestListenerBusy(t *testing.T) {
	held, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Close() }()
	_, err = net.Listen("tcp", held.Addr().String())
	if err == nil {
		t.Skip("this OS lets a second listener share the port")
	}
	wrapped := fmt.Errorf("config failed to refresh token: %w", fmt.Errorf("failed to start auth webserver: %w", err))
	if got := listenerBusy(wrapped); got != held.Addr().String() {
		t.Errorf("busy %q, want %s (%v)", got, held.Addr(), wrapped)
	}
	if got := listenerBusy(errors.New("address already in use")); got != "" {
		t.Errorf("words alone %q", got)
	}
	if got := stepView(&Step{State: StateFailed, Busy: "127.0.0.1:53682"}).Busy; got != "127.0.0.1:53682" {
		t.Errorf("wire %+v", got)
	}
	if got := stepView(&Step{State: StateFailed, Busy: listenerBusy(&net.OpError{Op: "listen", Err: errAddrInUse})}).Busy; got != "the sign-in port" {
		t.Errorf("an unknown address: %q", got)
	}
}

// slowOpen, when set, blocks each open of a slowinfo remote until its release channel is
// closed, and signals when an open starts.
var slowOpen atomic.Pointer[struct{ opening, release chan struct{} }]

func init() {
	// A memory remote that is slow to open, like a distant remote.
	fs.Register(&fs.RegInfo{
		Name: "slowinfo", Description: "a memory remote slow to open",
		NewFs: func(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
			if gate := slowOpen.Load(); gate != nil {
				select {
				case gate.opening <- struct{}{}:
				default:
				}
				<-gate.release
			}
			mem, err := fs.Find("memory")
			if err != nil {
				return nil, err
			}
			return mem.NewFs(ctx, name, root, m)
		},
	})
}

// TestFSInfoAfterAChangeMidRefresh checks that when a remote's config changes while its fsinfo
// is being read, the fsinfo is read again. The pages' list after the change found the read
// already running, so it didn't request its own.
func TestFSInfoAfterAChangeMidRefresh(t *testing.T) {
	ctx := context.Background()
	gate := &struct{ opening, release chan struct{} }{make(chan struct{}, 1), make(chan struct{})}
	slowOpen.Store(gate)
	defer slowOpen.Store(nil)
	s, _ := setup(t, "[slow]\ntype = slowinfo\n")
	if _, err := s.List(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gate.opening:
	case <-time.After(10 * time.Second):
		t.Fatal("no fsinfo read began")
	}
	s.Changed([]string{"slow"})
	if _, err := s.List(ctx); err != nil {
		t.Fatal(err)
	}
	close(gate.release)
	testutil.Eventually(t, 10*time.Second, "the fsinfo of the changed config", func() bool {
		rows, err := s.readSettings(ctx)
		return err == nil && rows["slow"].fsinfo != nil
	})
}

// TestFSInfoAsStored checks that the fsinfo read from rclone's package is stored as the same JSON
// that operations/fsinfo returns.
func TestFSInfoAsStored(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	fi, err := askFSInfo(ctx, dir, rclone.UIGroup("fsinfo", "test"))
	if err != nil {
		t.Fatal(err)
	}
	out, _, err := rclone.Call(ctx, "operations/fsinfo", rc.Params{"fs": dir}, rclone.CallOpts{})
	if err != nil {
		t.Fatal(err)
	}
	var old struct {
		Features     map[string]bool
		MetadataInfo *fs.MetadataInfo
		Hashes       []string
		Precision    int64
	}
	if err := rc.Reshape(&old, out); err != nil {
		t.Fatal(err)
	}
	decoded := func(fi FSInfo) (v any) {
		raw, _ := json.Marshal(fi)
		_ = json.Unmarshal(raw, &v)
		return v
	}
	want := decoded(FSInfo{Features: old.Features, MetadataInfo: old.MetadataInfo, Hashes: old.Hashes, Precision: old.Precision})
	if got := decoded(fi); !reflect.DeepEqual(got, want) || fi.MetadataInfo == nil {
		t.Errorf("stored\n%v\nwas\n%v", got, want)
	}
}

func init() {
	// A backend whose config asks for a password and reveals the answer, as SugarSync's does.
	fs.Register(&fs.RegInfo{
		Name: "askpass", Description: "a backend that asks for a password",
		NewFs: func(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
			return nil, fs.ErrorNotImplemented
		},
		Config: func(ctx context.Context, name string, m configmap.Mapper, in fs.ConfigIn) (*fs.ConfigOut, error) {
			switch in.State {
			case "":
				return fs.ConfigPassword("pass_done", "config_pass", "Your password")
			case "pass_done":
				revealed, err := obscure.Reveal(in.Result)
				if err != nil {
					return nil, fmt.Errorf("Reveal failed: %w", err)
				}
				m.Set("seen", revealed)
			}
			return nil, nil
		},
		Options: []fs.Option{{Name: "seen", Help: "the password the config got"}},
	})
}

// TestSessionInteractiveQuestions checks that a password given as an answer to rclone's question
// reaches the backend obscured, as rclone's own config passes it on. Seafile's two-factor login
// is the exception and takes its password as plain text (its server is faked here).
func TestSessionInteractiveQuestions(t *testing.T) {
	s, sub := setup(t, "")
	st := runSession(t, s, sub, StartRequest{Kind: KindCreate, Name: "asker", Type: "askpass", NonInteractive: true})
	if st.State != StateQuestion || st.Question == nil || st.Question.Name != "config_pass" || !st.Question.IsPassword {
		t.Fatalf("step %+v", st)
	}
	if err := s.Sessions().Answer(context.Background(), st.ID, "s3cret"); err != nil {
		t.Fatal(err)
	}
	if st := waitDone(t, s, sub, st.ID); st.State != StateDone {
		t.Fatalf("after the answer: %+v", st)
	}
	if seen := s.section("asker")["seen"]; seen != "s3cret" {
		t.Fatalf("the backend revealed %q", seen)
	}

	var otp atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api2/auth-token/" {
			http.NotFound(w, r)
			return
		}
		var body struct{ Username, Password string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		otp.Store(r.Header.Get("X-Seafile-Otp"))
		w.Header().Set("Content-Type", "application/json")
		if body.Username != "me" || body.Password != "pw" || r.Header.Get("X-Seafile-Otp") != "123456" {
			_, _ = w.Write([]byte(`{"non_field_errors":["bad credentials"]}`))
			return
		}
		_, _ = w.Write([]byte(`{"token":"sea-token"}`))
	}))
	t.Cleanup(srv.Close)
	st = runSession(t, s, sub, StartRequest{Kind: KindCreate, Name: "sea", Type: "seafile",
		Values: map[string]any{"url": srv.URL, "user": "me", "2fa": true}})
	if st.State != StateQuestion || st.Question == nil || st.Question.Name != "config_password" || !st.Question.IsPassword {
		t.Fatalf("first step %+v", st)
	}
	if err := s.Sessions().Answer(context.Background(), st.ID, "pw"); err != nil {
		t.Fatal(err)
	}
	st = waitDone(t, s, sub, st.ID)
	if st.State != StateQuestion || st.Question == nil || st.Question.Name != "config_2fa" {
		t.Fatalf("second step %+v", st)
	}
	if err := s.Sessions().Answer(context.Background(), st.ID, "123456"); err != nil {
		t.Fatal(err)
	}
	if st := waitDone(t, s, sub, st.ID); st.State != StateDone {
		t.Fatalf("final %+v", st)
	}
	if v := s.section("sea")["auth_token"]; v != "sea-token" {
		t.Fatalf("auth_token = %q", v)
	}
	if otp.Load() != "123456" {
		t.Fatalf("the server got the code %v", otp.Load())
	}
}

// waitDone waits for session id to leave the working state, either for its next question or
// for its end.
func waitDone(t *testing.T, s *Service, sub *bus.Sub, id string) Step {
	t.Helper()
	for {
		cur := s.Sessions().Current(context.Background())
		if cur != nil && cur.ID == id && cur.State != StateWorking {
			return *cur
		}
		waitEvent(t, sub, bus.RemotesSession)
	}
}

// TestCallAfterItsSessionEnded checks a create's call that begins just as its session ends,
// from a cancel right after the start. The call is stopped and waited for, and the remote that
// it wrote after the end's cleanup is removed.
func TestCallAfterItsSessionEnded(t *testing.T) {
	s, _ := setup(t, "")
	ss := s.Sessions()
	x := &session{step: Step{ID: "late", Remote: "late", Kind: KindCreate, State: StateCancelled}, typ: "memory"}
	ss.mu.Lock()
	ss.cur = x
	ss.mu.Unlock()
	ss.run(x, func(ctx context.Context) (*fs.ConfigOut, error) {
		time.Sleep(100 * time.Millisecond) // a call that notices its stop late
		return config.CreateRemote(context.WithoutCancel(ctx), "late", "memory", rc.Params{}, config.UpdateRemoteOpt{})
	})
	if s.exists("late") {
		t.Fatal("the remote the call wrote after the session ended is left")
	}
}

// TestRenameFailureIsOnTheName checks that a rename that fails at the end of an edit session
// names the form's name field, so the edit form shows the error under the name.
func TestRenameFailureIsOnTheName(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a read-only folder still takes new files on Windows")
	}
	s, sub := setup(t, "[photos]\ntype = memory\n")
	dir := filepath.Dir(configPath)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(dir, 0o700) }()
	st := runSession(t, s, sub, StartRequest{Kind: KindUpdate, Name: "photos", NewName: "pictures"})
	if st.State != StateFailed || st.Field != "newName" || st.Error == nil || strings.HasPrefix(fmt.Sprint(st.Error), "The changes were saved") {
		t.Fatalf("the failed rename: %+v", st)
	}
	if v := stepView(&st); v.Field != "newName" {
		t.Errorf("the pages see the field %q", v.Field)
	}
}

// TestCheckRemote checks that the edit form's check runs again for that remote only.
func TestCheckRemote(t *testing.T) {
	s, sub := setup(t, "[ok]\ntype = memory\n\n[broken]\ntype = alias\nremote = /definitely/not/here\n")
	s.Health(context.Background())
	for got := 0; got < 2; got++ {
		waitEvent(t, sub, bus.RemotesHealth)
	}
	s.CheckRemote("broken")
	h := s.Health(context.Background())
	if h["broken"].State != HealthChecking || h["ok"].State != HealthOK {
		t.Fatalf("after the check was asked: %+v", h)
	}
	ev := waitEvent(t, sub, bus.RemotesHealth)
	if he := ev.Data.(bus.RemotesHealthData); he.ID != "broken" || he.State != HealthFaulty {
		t.Fatalf("health %+v", he)
	}
}

// TestSetupInTheAppsLanguage checks that a session's step names its remote's backend, which the
// pages' view needs to put rclone's questions and errors in the app's language. Seafile asks for
// a 2FA code, refuses a blank one, and shows its error with the question that it asks again.
func TestSetupInTheAppsLanguage(t *testing.T) {
	s, sub := setup(t, "")
	st := runSession(t, s, sub, StartRequest{Kind: KindCreate, Name: "sea", Type: "seafile",
		Values: map[string]any{"url": "https://seafile.invalid", "user": "me", "2fa": true}})
	if st.State != StateQuestion || st.Type != "seafile" || st.Question == nil || st.Question.Name != "config_password" {
		t.Fatalf("first step %+v", st)
	}
	for _, answer := range []string{"pw", ""} {
		if err := s.Sessions().Answer(context.Background(), st.ID, answer); err != nil {
			t.Fatal(err)
		}
		st = waitDone(t, s, sub, st.ID)
	}
	if st.State != StateQuestion || st.Notice == "" || st.Question == nil || st.Question.Name != "config_2fa" {
		t.Fatalf("after a blank code: %+v", st)
	}
	t.Cleanup(func() { _ = s.Sessions().Cancel(context.Background(), st.ID) })

	i18n.SetLanguage("es")
	defer i18n.SetLanguage(i18n.English)
	v := stepView(&st)
	if v.Notice == st.Notice || v.Notice != catalog.LocalNotice("seafile", st.Notice) {
		t.Errorf("the notice is %q", v.Notice)
	}
	if v.Question.Help == st.Question.Help || v.Question.Help != catalog.FromQuestion("seafile", st.Question).Help {
		t.Errorf("the question is %q", v.Question.Help)
	}
	// Without its backend, the step's texts stay English.
	st.Type = ""
	if v := stepView(&st); v.Notice != st.Notice || v.Question.Help != st.Question.Help {
		t.Errorf("a step without a backend gives %q and %q", v.Notice, v.Question.Help)
	}
	i18n.SetLanguage(i18n.English)
	st.Type = "seafile"
	if v := stepView(&st); v.Notice != st.Notice || v.Question.Help != st.Question.Help {
		t.Errorf("English gives %q and %q", v.Notice, v.Question.Help)
	}
}

// A page gets a failed session's error, and the saved items that a rename left, in the app's
// language.
func TestStepViewIsTranslated(t *testing.T) {
	st := &Step{State: StateDone, Error: errs.New("Nothing happened for too long, so the session was stopped."),
		Result: &StepResult{Name: "x", NotRewritten: []error{errs.Errorf("The favourite %s: %s is a favourite already", "a:b", "x:b")}}}
	i18n.SetLanguage(i18n.Pseudo)
	defer i18n.SetLanguage(i18n.English)
	v := stepView(st)
	if v.Error != "[Ñóthíñg háppéñéd fór tóó lóñg, só thé séssíóñ wás stóppéd.]" ||
		len(v.NotRewritten) != 1 || v.NotRewritten[0] != "[Thé fávóúríté a:b: x:b ís á fávóúríté álréádý]" {
		t.Errorf("view %q %q", v.Error, v.NotRewritten)
	}
}

// rclone can end a setup with an error and nowhere to go on from: a Seafile password left blank,
// a Google Drive account with no Shared Drives. That is a setup that failed, with rclone's error
// for the page, and for a new remote nothing is left behind. It used to count as done.
func TestSetupThatRcloneRefuses(t *testing.T) {
	s, sub := setup(t, "")
	st := runSession(t, s, sub, StartRequest{Kind: KindCreate, Name: "blank", Type: "seafile",
		Values: map[string]any{"url": "https://seafile.invalid", "user": "me", "2fa": true}})
	if st.State != StateQuestion || st.Question == nil || st.Question.Name != "config_password" {
		t.Fatalf("first step %+v", st)
	}
	if err := s.Sessions().Answer(context.Background(), st.ID, ""); err != nil {
		t.Fatal(err)
	}
	st = waitDone(t, s, sub, st.ID)
	if st.State != StateFailed || st.Error == nil || st.Error.Error() != "Password can't be blank" {
		t.Fatalf("after a blank password: state %s, error %v", st.State, st.Error)
	}
	// The session says that it failed, then removes what rclone had written.
	testutil.Eventually(t, 5*time.Second, "the remote that couldn't be set up is removed", func() bool {
		list, err := s.List(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range list {
			if r.Name == "blank" {
				return false
			}
		}
		return true
	})
	// The page gets rclone's error in the app's language.
	i18n.SetLanguage("es")
	defer i18n.SetLanguage(i18n.English)
	if v := stepView(&st); v.Error == "" || v.Error == "Password can't be blank" || v.Error != catalog.LocalNotice("seafile", "Password can't be blank") {
		t.Errorf("the error in Spanish is %q", v.Error)
	}
}
