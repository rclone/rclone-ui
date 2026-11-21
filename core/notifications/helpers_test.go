package notifications

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/internal/syncx"
	"github.com/rclone/rclone-ui/core/internal/testdb"
)

// fixture is a Service over a fresh app.db. Its senders run until the test ends, and hooks
// answers the webhooks, so nothing goes over the network.
type fixture struct {
	t       *testing.T
	s       *Service
	db      *db.DB
	secrets *memSecrets
	hooks   *fakeTransport
	watch   *bus.Sub
	ctx     context.Context
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	d := testdb.Open(t)
	b := bus.New()
	f := &fixture{t: t, db: d, secrets: &memSecrets{m: map[string]string{}}, hooks: &fakeTransport{},
		watch: b.Subscribe(), ctx: ctx}
	t.Cleanup(f.watch.Close)

	run, stop := context.WithCancel(ctx)
	var wg sync.WaitGroup
	runner := syncx.RunnerFunc(func(_ string, fn func(context.Context)) {
		wg.Go(func() { fn(run) })
	})
	f.s = New(d, f.secrets, b, &http.Client{Transport: f.hooks}, runner)
	f.s.version = "1.2.3"
	f.s.retryDelay = 10 * time.Millisecond
	f.s.Start()
	t.Cleanup(func() { stop(); wg.Wait() })
	return f
}

// memSecrets is an in-memory keychain. When getErr is set it can't be read, and when setErr is
// set it can't be written.
type memSecrets struct {
	mu             sync.Mutex
	m              map[string]string
	getErr, setErr error
}

var errNoSecret = errors.New("no such secret")

func (m *memSecrets) Get(account string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.getErr != nil {
		return "", m.getErr
	}
	v, ok := m.m[account]
	if !ok {
		return "", errNoSecret
	}
	return v, nil
}

func (m *memSecrets) Set(account, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.setErr != nil {
		return m.setErr
	}
	m.m[account] = value
	return nil
}

func (m *memSecrets) Delete(account string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.m, account)
	return nil
}

// changed waits for n notifications.changed events, and fails the test after 5 seconds.
func (f *fixture) changed(n int) {
	f.t.Helper()
	deadline := time.After(5 * time.Second)
	for n > 0 {
		select {
		case e := <-f.watch.C:
			if e.Name == bus.NotificationsChanged {
				n--
			}
		case <-deadline:
			f.t.Fatalf("still waiting for %d notifications.changed", n)
		}
	}
}

// quiet reports whether no notifications.changed arrives within d.
func (f *fixture) quiet(d time.Duration) bool {
	deadline := time.After(d)
	for {
		select {
		case e := <-f.watch.C:
			if e.Name == bus.NotificationsChanged {
				return false
			}
		case <-deadline:
			return true
		}
	}
}

func (f *fixture) create(in TargetInput) NotificationTarget {
	f.t.Helper()
	t, err := f.s.Create(f.ctx, in)
	if err != nil {
		f.t.Fatalf("create %+v: %v", in, err)
	}
	f.changed(1)
	return t
}

func (f *fixture) get(id string) NotificationTarget {
	f.t.Helper()
	t, err := f.s.Target(f.ctx, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return t
}

// captured is one webhook call, as the endpoint received it.
type captured struct {
	URL, ContentType, Event string
	Body                    string
}

// fakeTransport answers webhook calls in the test process. reply decides the response to each
// call, given its 0-based number. When reply is nil, every call gets a 200.
type fakeTransport struct {
	mu    sync.Mutex
	calls []captured
	reply func(n int, r *http.Request) (int, error)
}

func (ft *fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(r.Body)
	ft.mu.Lock()
	n := len(ft.calls)
	ft.calls = append(ft.calls, captured{r.URL.String(), r.Header.Get("Content-Type"), r.Header.Get("X-RcloneUI-Event"), string(body)})
	reply := ft.reply
	ft.mu.Unlock()
	status := http.StatusOK
	if reply != nil {
		var err error
		if status, err = reply(n, r); err != nil {
			return nil, err
		}
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}, Request: r}, nil
}

func (ft *fakeTransport) got() []captured {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return append([]captured(nil), ft.calls...)
}

func (ft *fakeTransport) set(reply func(n int, r *http.Request) (int, error)) {
	ft.mu.Lock()
	ft.calls, ft.reply = nil, reply
	ft.mu.Unlock()
}

// testCert is a self-signed certificate for 127.0.0.1, and a pool that trusts it.
func testCert(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "fake smtp"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, pool
}
