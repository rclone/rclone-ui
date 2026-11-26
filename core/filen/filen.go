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

var (
	ErrTwoFactor      = errs.Field("code", "This Filen account uses two-factor authentication: enter the code from your authenticator app.")
	ErrWrongTwoFactor = errs.Field("code", "That two-factor code was not accepted. Enter the current one.")
)

var login = func(ctx context.Context, email, password, code string) (string, error) {
	f, err := sdk.New(ctx, email, password, code)
	if err != nil {
		return "", err
	}
	return f.Client.APIKey, nil
}

var budget = 20 * time.Second

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
