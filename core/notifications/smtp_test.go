package notifications

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/errs"
)

// fakeSMTP is a minimal mail server on 127.0.0.1. It supports EHLO, STARTTLS or TLS from the
// first byte, AUTH PLAIN and LOGIN, the envelope and DATA. It records what the client sent in
// each session.
type fakeSMTP struct {
	t        *testing.T
	ln       net.Listener
	cert     tls.Certificate
	startTLS bool   // offer STARTTLS
	mechs    string // AUTH mechanisms offered ("" for none)
	user     string // the credentials it accepts
	pass     string
	// mailReplies are the replies to MAIL FROM, one per session in order. After them, 250.
	mailReplies []string
	hangUp      bool // close every connection immediately

	mu       sync.Mutex
	sessions []string
	conns    []net.Conn // closed when the test ends, because a client may leave one open
	wg       sync.WaitGroup
}

func newFakeSMTP(t *testing.T, implicitTLS bool, configure func(*fakeSMTP)) *fakeSMTP {
	t.Helper()
	cert, _ := testCert(t)
	f := &fakeSMTP{t: t, cert: cert, mechs: "PLAIN LOGIN", user: "postmaster", pass: "hunter2"}
	if configure != nil {
		configure(f)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if implicitTLS {
		ln = tls.NewListener(ln, &tls.Config{Certificates: []tls.Certificate{cert}})
	}
	f.ln = ln
	f.wg.Go(func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			f.mu.Lock()
			f.conns = append(f.conns, c)
			f.mu.Unlock()
			f.wg.Go(func() { f.session(c) })
		}
	})
	t.Cleanup(func() {
		_ = ln.Close()
		f.mu.Lock()
		for _, c := range f.conns {
			_ = c.Close()
		}
		f.mu.Unlock()
		f.wg.Wait()
	})
	return f
}

func (f *fakeSMTP) port() int { return f.ln.Addr().(*net.TCPAddr).Port }

func (f *fakeSMTP) got() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.sessions...)
}

func (f *fakeSMTP) session(c net.Conn) {
	var heard strings.Builder
	recorded := false
	record := func() {
		if recorded {
			return
		}
		recorded = true
		f.mu.Lock()
		f.sessions = append(f.sessions, heard.String())
		f.mu.Unlock()
	}
	defer func() {
		_ = c.Close()
		record()
	}()
	if f.hangUp {
		return
	}
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	_, secure := c.(*tls.Conn)
	r := bufio.NewReader(c)
	say := func(s string) { _, _ = c.Write([]byte(s + "\r\n")) }
	read := func() (string, bool) {
		line, err := r.ReadString('\n')
		heard.WriteString(line)
		return strings.TrimRight(line, "\r\n"), err == nil
	}
	f.mu.Lock()
	var mailReply string
	if len(f.mailReplies) > 0 {
		mailReply, f.mailReplies = f.mailReplies[0], f.mailReplies[1:]
	}
	f.mu.Unlock()
	say("220 fake ESMTP")
	for {
		line, ok := read()
		if !ok {
			return
		}
		verb, arg, _ := strings.Cut(line, " ")
		switch strings.ToUpper(verb) {
		case "EHLO":
			ext := []string{"fake"}
			if f.startTLS && !secure {
				ext = append(ext, "STARTTLS")
			}
			if f.mechs != "" {
				ext = append(ext, "AUTH "+f.mechs)
			}
			ext = append(ext, "8BITMIME")
			for i, e := range ext {
				sep := "-"
				if i == len(ext)-1 {
					sep = " "
				}
				say("250" + sep + e)
			}
		case "STARTTLS":
			say("220 go ahead")
			tc := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{f.cert}})
			if tc.Handshake() != nil {
				return
			}
			c, r, secure = tc, bufio.NewReader(tc), true
			heard.WriteString("-- TLS --\r\n")
		case "AUTH":
			mech, initial, _ := strings.Cut(arg, " ")
			var user, pass string
			switch strings.ToUpper(mech) {
			case "PLAIN":
				if initial == "" {
					say("334 ")
					initial, _ = read()
				}
				raw, _ := base64.StdEncoding.DecodeString(initial)
				parts := strings.Split(string(raw), "\x00")
				if len(parts) == 3 {
					user, pass = parts[1], parts[2]
				}
			case "LOGIN":
				say("334 VXNlcm5hbWU6")
				u, _ := read()
				say("334 UGFzc3dvcmQ6")
				p, _ := read()
				rawU, _ := base64.StdEncoding.DecodeString(u)
				rawP, _ := base64.StdEncoding.DecodeString(p)
				user, pass = string(rawU), string(rawP)
			}
			heard.WriteString("-- authenticated as " + user + " --\r\n")
			if user == f.user && pass == f.pass {
				say("235 2.7.0 Authentication successful")
			} else {
				say("535 5.7.8 Authentication credentials invalid")
			}
		case "MAIL":
			if mailReply != "" {
				say(mailReply)
			} else {
				say("250 OK")
			}
		case "DATA":
			say("354 go ahead")
			for {
				l, ok := read()
				if !ok {
					return
				}
				if l == "." {
					break
				}
			}
			say("250 queued")
		case "QUIT":
			// Record the session before replying. The client is done once it reads the reply,
			// and the test reads the session right after.
			record()
			say("221 bye")
			return
		default:
			say("250 OK")
		}
	}
}

func (f *fixture) saveSMTP(in SMTPInput) SMTPView {
	f.t.Helper()
	v, err := f.s.SetSMTP(f.ctx, in)
	if err != nil {
		f.t.Fatalf("SetSMTP %+v: %v", in, err)
	}
	f.changed(1)
	return v
}

func smtpInput(port int, enc SMTPEncryption) SMTPInput {
	return SMTPInput{
		Host: "127.0.0.1", Port: port, Encryption: enc, Username: "postmaster", Password: "hunter2",
		FromAddress: "rclone-ui@example.com", FromName: "Rclone UI",
	}
}

func TestSMTPSettingsRules(t *testing.T) {
	f := newFixture(t)
	if v, err := f.s.SMTP(f.ctx); err != nil || v != (SMTPView{}) {
		t.Fatalf("nothing saved: %+v, %v", v, err)
	}

	v := f.saveSMTP(smtpInput(587, SMTPEncryptionStartTLS))
	want := SMTPView{Host: "127.0.0.1", Port: 587, Encryption: SMTPEncryptionStartTLS, Username: "postmaster",
		HasPassword: true, FromAddress: "rclone-ui@example.com", FromName: "Rclone UI"}
	if v != want {
		t.Fatalf("view = %+v, want %+v", v, want)
	}
	// The password is stored in the keychain, never in the database.
	var host string
	if err := f.db.Read(context.Background(), func(tx *sql.Tx) error {
		return tx.QueryRow(`SELECT host FROM notification_smtp`).Scan(&host)
	}); err != nil || host != "127.0.0.1" {
		t.Fatalf("stored host %q, %v", host, err)
	}
	if pw, _ := f.secrets.Get(smtpAccount); pw != "hunter2" {
		t.Fatalf("keychain password %q", pw)
	}

	saved := func() SMTP {
		c, err := f.s.savedSMTP(context.Background())
		if err != nil || c == nil {
			t.Fatalf("saved: %v, %v", c, err)
		}
		return *c
	}
	// An empty password keeps the saved one.
	in := smtpInput(587, SMTPEncryptionStartTLS)
	in.Password, in.FromName = "", "Backups"
	if v := f.saveSMTP(in); !v.HasPassword || v.FromName != "Backups" || saved().Password != "hunter2" {
		t.Fatalf("empty password: view %+v, saved %+v", v, saved())
	}
	// A new one replaces it.
	in.Password = "correct horse"
	f.saveSMTP(in)
	if saved().Password != "correct horse" {
		t.Fatalf("new password not saved: %+v", saved())
	}
	// A keychain that can't be read returns a blank password, and the stored one is kept.
	in.Password = ""
	f.secrets.mu.Lock()
	f.secrets.getErr = errors.New("the keychain is locked")
	f.secrets.mu.Unlock()
	f.saveSMTP(in)
	f.secrets.mu.Lock()
	f.secrets.getErr = nil
	f.secrets.mu.Unlock()
	if saved().Password != "correct horse" {
		t.Fatalf("an unreadable keychain lost the password: %+v", saved())
	}
	// When the keychain can't be written, nothing is saved, so there is never a server
	// without its password.
	moved := in
	moved.Host, moved.Password = "smtp.example.com", "battery staple"
	f.secrets.mu.Lock()
	f.secrets.setErr = errors.New("the keychain is read-only")
	f.secrets.mu.Unlock()
	if _, err := f.s.SetSMTP(f.ctx, moved); err == nil {
		t.Fatal("saved without its password")
	}
	f.secrets.mu.Lock()
	f.secrets.setErr = nil
	f.secrets.mu.Unlock()
	if c := saved(); c.Host != "127.0.0.1" || c.Password != "correct horse" {
		t.Fatalf("after a failed save: %+v", c)
	}
	// An empty username removes the password (a relay without credentials).
	in.Username, in.Password = " ", ""
	if v := f.saveSMTP(in); v.HasPassword || v.Username != "" || saved().Password != "" {
		t.Fatalf("empty username: view %+v, saved %+v", v, saved())
	}

	for _, c := range []struct {
		name  string
		edit  func(*SMTPInput)
		field string
		msg   string
	}{
		{"port 0", func(in *SMTPInput) { in.Port = 0 }, "port", "Enter a port between 1 and 65535."},
		{"port too high", func(in *SMTPInput) { in.Port = 65536 }, "port", "Enter a port between 1 and 65535."},
		{"encryption", func(in *SMTPInput) { in.Encryption = "ssl" }, "encryption", "Choose STARTTLS, SSL / TLS or None for the encryption."},
		{"no from", func(in *SMTPInput) { in.FromAddress = " " }, "fromAddress", "Enter the from address, as in rclone-ui@example.com."},
		{"bad from", func(in *SMTPInput) { in.FromAddress = "not an address" }, "fromAddress", "‘not an address’ is not an email address."},
		{"from with a name", func(in *SMTPInput) { in.FromAddress = "Ops <ops@example.com>" }, "fromAddress", "‘Ops <ops@example.com>’ is not an email address."},
	} {
		in := smtpInput(587, SMTPEncryptionStartTLS)
		c.edit(&in)
		_, err := f.s.SetSMTP(f.ctx, in)
		var ae *errs.FieldError
		if !errors.As(err, &ae) || ae.Field != c.field || ae.Message != c.msg {
			t.Errorf("%s: err = %v, want %s: %s", c.name, err, c.field, c.msg)
		}
	}
	if saved().FromName != "Backups" {
		t.Fatalf("a refused save changed the settings: %+v", saved())
	}

	// An empty host clears everything.
	if v := f.saveSMTP(SMTPInput{Host: "  ", Port: 587}); v != (SMTPView{}) {
		t.Fatalf("cleared view = %+v", v)
	}
	if c, err := f.s.savedSMTP(context.Background()); err != nil || c != nil {
		t.Fatalf("an empty host left the settings: %+v, %v", c, err)
	}
	if _, err := f.secrets.Get(smtpAccount); err == nil {
		t.Fatal("an empty host left the password")
	}
}

func TestSMTPTestUsesTheSavedServer(t *testing.T) {
	f := newFixture(t)
	if o, err := f.s.TestSMTP(f.ctx, "ops@example.com"); err != nil || o.OK || o.Message != errNotSetUp.Error() {
		t.Fatalf("nothing saved: %+v, %v", o, err)
	}
	srv := newFakeSMTP(t, false, nil)
	f.saveSMTP(smtpInput(srv.port(), SMTPEncryptionNone))
	o, err := f.s.TestSMTP(f.ctx, " ops@example.com ")
	if err != nil || !o.OK || o.Message != "A test email went to ops@example.com." {
		t.Fatalf("test = %+v, %v", o, err)
	}
	sessions := srv.got()
	if len(sessions) != 1 {
		t.Fatalf("%d sessions", len(sessions))
	}
	for _, want := range []string{
		"-- authenticated as postmaster --",
		"MAIL FROM:<rclone-ui@example.com>",
		"RCPT TO:<ops@example.com>",
		"Subject: Test notification",
		`From: "Rclone UI" <rclone-ui@example.com>`,
		"This is a test notification from Rclone UI.",
		"Rclone UI v1.2.3",
	} {
		if !strings.Contains(sessions[0], want) {
			t.Errorf("session lacks %q:\n%s", want, sessions[0])
		}
	}
	for _, c := range []struct{ to, msg string }{
		{" , ", "Enter at least one email address."},
		{"nope", "‘nope’ is not an email address."},
	} {
		if o, err := f.s.TestSMTP(f.ctx, c.to); err != nil || o.OK || o.Message != c.msg {
			t.Errorf("to %q: %+v, %v; want %q", c.to, o, err, c.msg)
		}
	}
}

func TestMailEncryptionAndAuth(t *testing.T) {
	for _, c := range []struct {
		name     string
		implicit bool
		enc      SMTPEncryption
		server   func(*fakeSMTP)
		user     string
		want     []string
		wantErr  string
	}{
		{name: "starttls, plain", enc: SMTPEncryptionStartTLS, server: func(s *fakeSMTP) { s.startTLS = true },
			user: "postmaster", want: []string{"-- TLS --", "AUTH PLAIN ", "-- authenticated as postmaster --"}},
		{name: "starttls, login only", enc: SMTPEncryptionStartTLS, server: func(s *fakeSMTP) { s.startTLS, s.mechs = true, "LOGIN" },
			user: "postmaster", want: []string{"-- TLS --", "AUTH LOGIN", "-- authenticated as postmaster --"}},
		{name: "starttls refused by the server", enc: SMTPEncryptionStartTLS, user: "postmaster",
			wantErr: "does not support STARTTLS"},
		{name: "implicit tls", implicit: true, enc: SMTPEncryptionTLS,
			user: "postmaster", want: []string{"AUTH PLAIN ", "-- authenticated as postmaster --"}},
		{name: "none, credentials in the clear", enc: SMTPEncryptionNone, server: func(s *fakeSMTP) { s.startTLS = true },
			user: "postmaster", want: []string{"AUTH PLAIN ", "-- authenticated as postmaster --"}},
		{name: "no credentials: no AUTH", enc: SMTPEncryptionNone, want: []string{"MAIL FROM:"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			srv := newFakeSMTP(t, c.implicit, c.server)
			f.s.tlsRoots = poolOf(srv.cert)
			cfg := SMTP{Host: "127.0.0.1", Port: srv.port(), Encryption: string(c.enc), Username: c.user,
				Password: "hunter2", FromAddress: "rclone-ui@example.com"}
			err := f.s.mail(context.Background(), cfg, []string{"ops@example.com", "alice@example.com"}, "Subject here", "Body here")
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("err = %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			s := srv.got()[0]
			if c.user == "" && strings.Contains(s, "AUTH") {
				t.Errorf("authenticated without credentials:\n%s", s)
			}
			if c.enc == SMTPEncryptionNone && strings.Contains(s, "-- TLS --") {
				t.Errorf("upgraded a plain connection:\n%s", s)
			}
			for _, w := range append(c.want, "RCPT TO:<ops@example.com>", "RCPT TO:<alice@example.com>", "Subject: Subject here", "Body here") {
				if !strings.Contains(s, w) {
					t.Errorf("session lacks %q:\n%s", w, s)
				}
			}
		})
	}
}

func poolOf(cert tls.Certificate) *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(cert.Leaf)
	return p
}

func TestMailRetry(t *testing.T) {
	cfg := func(port int) SMTP {
		return SMTP{Host: "127.0.0.1", Port: port, Encryption: "none", FromAddress: "rclone-ui@example.com"}
	}
	for _, c := range []struct {
		name     string
		server   func(*fakeSMTP)
		sessions int
		ok       bool
	}{
		{"a temporary refusal is tried again", func(s *fakeSMTP) { s.mailReplies = []string{"451 4.7.1 greylisted"} }, 2, true},
		{"a dropped connection is tried again", func(s *fakeSMTP) { s.hangUp = true }, 2, false},
		{"a permanent refusal is not", func(s *fakeSMTP) { s.mailReplies = []string{"550 5.7.1 relaying denied"} }, 1, false},
		{"a wrong password is not", func(s *fakeSMTP) { s.pass = "other" }, 1, false},
		{"twice temporary: one retry only", func(s *fakeSMTP) { s.mailReplies = []string{"451 a", "451 b", "451 c"} }, 2, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			srv := newFakeSMTP(t, false, c.server)
			conf := cfg(srv.port())
			if c.name == "a wrong password is not" {
				conf.Username, conf.Password = "postmaster", "hunter2"
			}
			err := f.s.mail(context.Background(), conf, []string{"ops@example.com"}, "S", "B")
			if (err == nil) != c.ok {
				t.Fatalf("err = %v, want ok %v", err, c.ok)
			}
			// The server records a session when its connection ends.
			deadline := time.Now().Add(2 * time.Second)
			for len(srv.got()) < c.sessions && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if got := len(srv.got()); got != c.sessions {
				t.Fatalf("%d sessions, want %d (err %v)", got, c.sessions, err)
			}
		})
	}
}
