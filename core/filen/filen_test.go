package filen

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// stand replaces the SDK's login with fn for one test.
func stand(t *testing.T, fn func(ctx context.Context, email, password, code string) (string, error)) {
	t.Helper()
	was := login
	login = fn
	t.Cleanup(func() { login = was })
}

// twoFactorAccount acts as an account with two-factor authentication. It returns the SDK's errors
// with the same text as Filen's gateway.
func twoFactorAccount(_ context.Context, email, password, code string) (string, error) {
	switch {
	case email != "me@example.com" || password != "hunter2":
		return "", fmt.Errorf("failed to log in: response error: Invalid email address or password. email_or_password_wrong")
	case code == noCode:
		return "", fmt.Errorf("failed to log in: response error: Please enter your Two Factor Authentication code. enter_2fa")
	case code != "123456":
		return "", fmt.Errorf("failed to log in: response error: Invalid Two Factor Authentication code. wrong_2fa")
	}
	return "the-key", nil
}

func TestAPIKey(t *testing.T) {
	stand(t, twoFactorAccount)
	for _, tc := range []struct {
		name, email, password, code string
		key                         string
		err                         error
		msg                         string
	}{
		{name: "no email", password: "hunter2", msg: "Enter your Filen email and password"},
		{name: "no password", email: "me@example.com", msg: "Enter your Filen email and password"},
		{name: "wants a code", email: " me@example.com ", password: "hunter2", err: ErrTwoFactor},
		{name: "wrong code", email: "me@example.com", password: "hunter2", code: "000000", err: ErrWrongTwoFactor},
		{name: "right code", email: "me@example.com", password: "hunter2", code: " 123456 ", key: "the-key"},
		{name: "wrong password", email: "me@example.com", password: "nope", msg: "Filen refused the login: Invalid email address or password. email_or_password_wrong"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key, err := APIKey(context.Background(), tc.email, tc.password, tc.code)
			if key != tc.key {
				t.Errorf("key = %q, want %q", key, tc.key)
			}
			switch {
			case tc.err != nil && !errors.Is(err, tc.err):
				t.Errorf("err = %v, want %v", err, tc.err)
			case tc.msg != "" && (err == nil || !strings.HasPrefix(err.Error(), tc.msg)):
				t.Errorf("err = %v, want %q…", err, tc.msg)
			case tc.err == nil && tc.msg == "" && err != nil:
				t.Errorf("err = %v", err)
			}
		})
	}
}

func TestAPIKeySendsNoCodePlaceholder(t *testing.T) {
	var got string
	stand(t, func(_ context.Context, _, _, code string) (string, error) { got = code; return "k", nil })
	if _, err := APIKey(context.Background(), "me@example.com", "pw", ""); err != nil {
		t.Fatal(err)
	}
	if got != noCode {
		t.Errorf("code sent = %q, want %q", got, noCode)
	}
}

// Unexpected results from the SDK become a sentence for the user, never a crash or an empty key.
func TestAPIKeyOddAnswers(t *testing.T) {
	for _, tc := range []struct {
		name string
		fn   func(context.Context, string, string, string) (string, error)
		msg  string
	}{
		{"empty key", func(context.Context, string, string, string) (string, error) { return "", nil }, "Filen did not return an API key."},
		{"unknown auth version", func(context.Context, string, string, string) (string, error) { panic("unimplemented") }, "Filen answered in a way this version cannot read (unimplemented)."},
		{"timeout", func(context.Context, string, string, string) (string, error) {
			return "", fmt.Errorf("failed to log in: %w", context.DeadlineExceeded)
		}, "Filen did not answer in time."},
		{"unreachable", func(context.Context, string, string, string) (string, error) {
			return "", errors.New("dial tcp: no route to host")
		}, "Could not reach Filen: dial tcp: no route to host"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stand(t, tc.fn)
			key, err := APIKey(context.Background(), "me@example.com", "pw", "")
			if key != "" || err == nil || err.Error() != tc.msg {
				t.Errorf("= %q, %v; want the error %q", key, err, tc.msg)
			}
		})
	}
}

// A login that never answers, even one that ignores its context, is given up after the budget.
func TestAPIKeyBudget(t *testing.T) {
	was := budget
	budget = 50 * time.Millisecond
	t.Cleanup(func() { budget = was })
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	stand(t, func(context.Context, string, string, string) (string, error) {
		<-block
		return "late", nil
	})
	start := time.Now()
	key, err := APIKey(context.Background(), "me@example.com", "pw", "")
	if key != "" || err == nil || err.Error() != "Filen did not answer in time." {
		t.Errorf("= %q, %v; want the timeout", key, err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Errorf("gave up after %s", took)
	}
	if budget := 20 * time.Second; was != budget {
		t.Errorf("the budget is %s, want %s", was, budget)
	}
}
