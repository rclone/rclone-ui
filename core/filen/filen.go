// Package filen gets a Filen account's API key for the API key field in the remote forms. rclone's
// filen backend needs a key but cannot fetch one (the option's help says to run the Filen CLI's
// `export-api-key`). The core logs in the same way that command does, using Filen's own Go SDK.
// rclone's backend is built on that SDK, so it is already in the build. The SDK handles every
// Filen auth version and two-factor codes, and its requests go through rclone's HTTP client,
// including the proxy from Settings. The password is the one that the form already has for the
// remote, because rclone keeps it in the remote's config.
package filen

import (
	"context"
	"errors"
	"strings"
	"time"

	sdk "github.com/FilenCloudDienste/filen-sdk-go/filen"

	"github.com/rclone/rclone-ui/core/errs"
)

// noCode is the two-factor code that Filen's clients send for an account without two-factor
// authentication.
const noCode = "XXXXXX"

// The errors for the request's `code` field that the form acts on. ErrTwoFactor asks for the
// account's two-factor code, and ErrWrongTwoFactor asks for it again.
var (
	ErrTwoFactor      = errs.Field("code", "This Filen account uses two-factor authentication: enter the code from your authenticator app.")
	ErrWrongTwoFactor = errs.Field("code", "That two-factor code was not accepted. Enter the current one.")
)

// login logs in with the SDK and returns the account's API key. The e2e build and the tests
// replace it with a stand-in, because they can't reach Filen's gateway.
var login = func(ctx context.Context, email, password, code string) (string, error) {
	f, err := sdk.New(ctx, email, password, code)
	if err != nil {
		return "", err
	}
	return f.Client.APIKey, nil
}

// budget is how long a login may take. A gateway that doesn't answer would otherwise keep the
// Generate button spinning.
var budget = 20 * time.Second

// APIKey logs in to the account and returns its API key. code is the two-factor code, or empty
// when there is none. Every error is a sentence to show to the user: ErrTwoFactor when the
// account needs a code, ErrWrongTwoFactor when the code was wrong, and Filen's own message
// otherwise. The login is given up after budget, even when the SDK doesn't stop by itself.
func APIKey(ctx context.Context, email, password, code string) (string, error) {
	email, code = strings.TrimSpace(email), strings.TrimSpace(code)
	if email == "" || password == "" {
		return "", errs.New("Enter your Filen email and password above, then press Generate.")
	}
	if code == "" {
		code = noCode
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	type answer struct {
		key string
		err error
	}
	done := make(chan answer, 1)
	fn := login
	go func() {
		defer func() {
			// The SDK panics on an auth version it does not know yet.
			if r := recover(); r != nil {
				done <- answer{err: errs.Errorf("Filen answered in a way this version cannot read (%v).", r)}
			}
		}()
		key, err := fn(ctx, email, password, code)
		done <- answer{key, err}
	}()
	var a answer
	select {
	case a = <-done:
	case <-ctx.Done():
		a.err = ctx.Err()
	}
	key, err := a.key, a.err
	switch {
	case err == nil && key == "":
		return "", errs.New("Filen did not return an API key.")
	case err == nil:
		return key, nil
	case strings.Contains(err.Error(), "enter_2fa"):
		return "", ErrTwoFactor
	case strings.Contains(err.Error(), "wrong_2fa"):
		return "", ErrWrongTwoFactor
	case errs.Is(err):
		return "", err
	case errors.Is(err, context.DeadlineExceeded):
		return "", errs.New("Filen did not answer in time.")
	}
	// The SDK formats Filen's own errors as "…: response error: <message> <code>".
	if _, said, ok := strings.Cut(err.Error(), "response error: "); ok {
		return "", errs.Errorf("Filen refused the login: %s", strings.TrimSpace(said))
	}
	return "", errs.Errorf("Could not reach Filen: %v", err)
}
