package rclone

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/fserrors"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

// TestErrorOf checks the one classifier that every error a page receives goes through. The core's
// own errors keep their code, even when wrapped, and come before rclone's: a canceled call that
// names a reconnect is still canceled. rclone's advice to reconnect names the remote, rclone's
// missing file or folder is not_found with a sentence of the app's own, and anything else is
// failed with its message unchanged.
func TestErrorOf(t *testing.T) {
	gone := errs.NotFound("watcher", "This watcher no longer exists.")
	expired := errors.New(`token expired - manually refresh with "rclone config reconnect work:"`)
	for _, c := range []struct {
		name    string
		err     error
		code    errs.Code
		message string
		remote  string
		field   string
	}{
		{"the core's error", fmt.Errorf("pausing: %w", gone), errs.CodeNotFound, "This watcher no longer exists.", "", ""},
		{"a field's refusal", fmt.Errorf("saving: %w", errs.Field("name", "Taken.")), errs.CodeInvalid, "saving: Taken.", "", "name"},
		{"a sentence", errs.New("Nothing to rename."), errs.CodeInvalid, "Nothing to rename.", "", ""},
		{"a canceled call", fmt.Errorf("listing: %w", context.Canceled), errs.CodeCanceled, "listing: context canceled", "", ""},
		{"a timeout", context.DeadlineExceeded, errs.CodeCanceled, "This took too long, so it was stopped. (context deadline exceeded)", "", ""},
		{"canceled before reconnect", fmt.Errorf("%w: %w", expired, context.Canceled), errs.CodeCanceled, expired.Error() + ": context canceled", "", ""},
		{"reconnect", fmt.Errorf("listing: %w", expired), errs.CodeReconnect, "listing: " + expired.Error(), "work", ""},
		{"a missing folder", fmt.Errorf("list: %w", fs.ErrorDirNotFound), errs.CodeNotFound, "That folder doesn't exist. (list: directory not found)", "", ""},
		{"a missing file", fs.ErrorObjectNotFound, errs.CodeNotFound, "That file doesn't exist. (object not found)", "", ""},
		{"the core is away", errs.Unavailable(errors.New("stopping")), errs.CodeUnavailable, "stopping", "", ""},
		{"a database failure", errs.Internal(errors.New("disk full")), errs.CodeInternal, "disk full", "", ""},
		{"anything else", errors.New("bucket does not exist"), errs.CodeFailed, "bucket does not exist", "", ""},
	} {
		e := ErrorOf(c.err)
		field := ""
		if len(e.Fields) > 0 {
			field = e.Fields[0].Field
		}
		if e.Code != c.code || e.Message != c.message || e.Remote != c.remote || field != c.field {
			t.Errorf("%s: %+v, want %s %q", c.name, e, c.code, c.message)
		}
	}
	if ErrorOf(nil) != nil {
		t.Error("no error became one")
	}
}

// TestErrorOfSentences checks that the rclone errors a user can meaningfully hit are recognised by
// their type, even when wrapped, and get a sentence of the app's own with rclone's words after
// it. Their code doesn't change, and the sentence is translated when the page receives it.
func TestErrorOfSentences(t *testing.T) {
	dial := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("no route")}
	for _, c := range []struct {
		name string
		err  error
		want string
	}{
		{"a named error", fmt.Errorf("copy: %w", fs.ErrorCantUploadEmptyFiles), "This remote can't store empty files. (copy: can't upload empty files to this remote)"},
		{"not in the config", fs.ErrorNotFoundInConfigFile, "That remote isn't in the config file. (didn't find section in config file)"},
		{"overlapping remotes", fs.ErrorOverlapping, "The source and the destination overlap, so files can't be synced or moved between them. Exclude the destination with a filter rule. (" + fs.ErrorOverlapping.Error() + ")"},
		{"rclone's permission error", fs.ErrorPermissionDenied, "You don't have permission to do that. (permission denied)"},
		{"the system's permission error", &os.PathError{Op: "open", Path: "/x", Err: os.ErrPermission}, "You don't have permission to do that. (open /x: permission denied)"},
		{"a missing local file", &os.PathError{Op: "open", Path: "/x", Err: os.ErrNotExist}, "That file or folder doesn't exist. (open /x: file does not exist)"},
		{"a full disk", fmt.Errorf("write: %w", diskFullError), "There is no space left on the disk. (write: " + diskFullError.Error() + ")"},
		{"rate limiting", fmt.Errorf("upload: %w", fserrors.ErrorRetryAfter(time.Now().Add(time.Hour))), "The service is limiting requests. Try again later. ("},
		{"a lookup", &net.DNSError{Err: "no such host", Name: "example.invalid", IsNotFound: true}, "The server's address couldn't be found. Check the internet connection. (lookup example.invalid: no such host)"},
		{"a network timeout", &net.OpError{Op: "read", Net: "tcp", Err: timeoutError{}}, "The server didn't answer in time. Check the internet connection. (read tcp: i/o timeout)"},
		{"no connection", dial, "Couldn't connect to the server. Check the internet connection. (dial tcp: no route)"},
	} {
		e := ErrorOf(c.err)
		if e.Code != errs.CodeFailed || !strings.HasPrefix(e.Message, c.want) || !strings.HasSuffix(e.Message, ")") {
			t.Errorf("%s: %s %q, want failed %q", c.name, e.Code, e.Message, c.want)
		}
	}
	// An error of any other type keeps rclone's words alone.
	if e := ErrorOf(errors.New("bucket does not exist")); e.Message != "bucket does not exist" {
		t.Errorf("an unknown error: %q", e.Message)
	}

	i18n.SetLanguage(i18n.Pseudo)
	defer i18n.SetLanguage(i18n.English)
	e := ErrorOf(fs.ErrorDirNotFound).Localized()
	if e.Message == "That folder doesn't exist. (directory not found)" || !strings.Contains(e.Message, "(directory not found)") {
		t.Errorf("the sentence isn't translated, or rclone's words are: %q", e.Message)
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
