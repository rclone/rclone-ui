package rclone

import (
	"context"
	"errors"
	"net"
	"os"
	"strings"
	"syscall"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/fserrors"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

// reconnectAdvice is the start of the advice rclone gives when a sign-in can't be refreshed,
// for example "token expired and there's no refresh token - manually refresh with \"rclone
// config reconnect work:\"". lib/oauthutil quotes it, and a few backends write it unquoted.
const reconnectAdvice = "rclone config reconnect "

// ReconnectAdvice returns the remote that err says must be signed in again. It reads the name
// from rclone's exact advice "rclone config reconnect <name>:". That is the remote rclone names,
// never a wrapper: for a crypt over a drive whose sign-in expired, it names the drive. The name
// can't contain spaces, except in rclone's quoted form ("…reconnect <name>:\""), where it runs
// up to the colon. Advice without a remote ("…reconnect <remote name>: ", "…reconnect to fix
// this") doesn't count.
func ReconnectAdvice(err error) (remote string, ok bool) {
	if err == nil {
		return "", false
	}
	text := err.Error()
	for {
		i := strings.Index(text, reconnectAdvice)
		if i < 0 {
			return "", false
		}
		text = text[i+len(reconnectAdvice):]
		name, rest, found := strings.Cut(text, ":")
		quoted := strings.HasPrefix(rest, `"`)
		if found && validName(name) && (quoted || !strings.Contains(name, " ")) {
			return name, true
		}
	}
}

// HasReconnectAdvice reports whether err contains the advice for exactly this remote. The
// health check offers a reconnect only in that case.
func HasReconnectAdvice(err error, remote string) bool {
	return err != nil && strings.Contains(err.Error(), reconnectAdvice+remote+":")
}

// ErrorOf converts any error into the form that the pages receive. It is the only classifier:
// the shell calls it for every error that a page receives. The core's own errors come first, as
// errs.Of converts them: an *errs.Error as it is, a refusal as Invalid, and a canceled call as
// Canceled. Then an expired sign-in carries the remote to reconnect, and rclone's missing file or
// folder becomes NotFound. Anything else is Failed, which the pages may try again.
//
// rclone's errors are English. Those that a user can meaningfully hit are recognised by their
// type (sentence), and the page gets a sentence of the app's own, which is translated, with
// rclone's words after it in brackets. Any other error keeps rclone's words alone.
func ErrorOf(err error) *errs.Error {
	if err == nil {
		return nil
	}
	if e := errs.Of(err); e != nil {
		var own *errs.Error
		if e.Code == errs.CodeCanceled && !errors.As(err, &own) && !errors.Is(err, context.Canceled) &&
			errors.Is(err, context.DeadlineExceeded) {
			// i18n: rclone's own words follow in brackets, in English.
			return errs.Canceled("This took too long, so it was stopped. (%s)", err.Error())
		}
		return e
	}
	if remote, ok := ReconnectAdvice(err); ok {
		return errs.Reconnect(remote, err)
	}
	switch {
	case errors.Is(err, fs.ErrorDirNotFound):
		// i18n: rclone's own words follow in brackets, in English.
		return errs.NotFound("", "That folder doesn't exist. (%s)", err.Error())
	case errors.Is(err, fs.ErrorObjectNotFound):
		// i18n: rclone's own words follow in brackets, in English.
		return errs.NotFound("", "That file doesn't exist. (%s)", err.Error())
	}
	if text := sentence(err); !text.IsZero() {
		return errs.Said(errs.CodeFailed, text)
	}
	return errs.Failed(err)
}

// sentence returns the app's own sentence for one of rclone's errors that a user can meaningfully
// hit, recognised by its type, with rclone's words as its value. It returns the zero Text for
// any other error. rclone's named errors come first, then the system's and the network's.
func sentence(err error) i18n.Text {
	words := err.Error()
	switch {
	case errors.Is(err, fs.ErrorNotFoundInConfigFile):
		return i18n.M("That remote isn't in the config file. (%s)", words)
	case errors.Is(err, fs.ErrorIsFile):
		return i18n.M("That is a file, not a folder. (%s)", words)
	case errors.Is(err, fs.ErrorIsDir):
		return i18n.M("That is a folder, not a file. (%s)", words)
	case errors.Is(err, fs.ErrorNotAFile):
		return i18n.M("That isn't a regular file. (%s)", words)
	case errors.Is(err, fs.ErrorDirExists):
		return i18n.M("A folder with that name already exists at the destination. (%s)", words)
	case errors.Is(err, fs.ErrorDirectoryNotEmpty):
		return i18n.M("That folder isn't empty. (%s)", words)
	case errors.Is(err, fs.ErrorCantCopy):
		return i18n.M("These remotes can't copy the file between them directly. (%s)", words)
	case errors.Is(err, fs.ErrorCantMove):
		return i18n.M("These remotes can't move the file between them directly. (%s)", words)
	case errors.Is(err, fs.ErrorCantDirMove):
		return i18n.M("These remotes can't move the folder between them directly. (%s)", words)
	case errors.Is(err, fs.ErrorCantPurge):
		return i18n.M("This remote can't delete a folder and everything in it at once. (%s)", words)
	case errors.Is(err, fs.ErrorCantUploadEmptyFiles):
		return i18n.M("This remote can't store empty files. (%s)", words)
	case errors.Is(err, fs.ErrorCantSetModTimeWithoutDelete):
		return i18n.M("This remote can only change a file's modification time by uploading the file again. (%s)", words)
	case errors.Is(err, fs.ErrorCantSetModTime):
		return i18n.M("This remote can't change a file's modification time. (%s)", words)
	case errors.Is(err, fs.ErrorCantShareDirectories):
		return i18n.M("This remote can't make a public link to a folder. (%s)", words)
	case errors.Is(err, fs.ErrorCantListRoot):
		return i18n.M("This remote can't list its top folder. Add a folder or a bucket to the path. (%s)", words)
	case errors.Is(err, fs.ErrorListBucketRequired):
		return i18n.M("Add a bucket or a container to the path, as in remote:bucket. (%s)", words)
	case errors.Is(err, fs.ErrorOverlapping):
		return i18n.M("The source and the destination overlap, so files can't be synced or moved between them. Exclude the destination with a filter rule. (%s)", words)
	case errors.Is(err, fs.ErrorNotDeleting):
		return i18n.M("Nothing was deleted, because other files failed to transfer. (%s)", words)
	case errors.Is(err, fs.ErrorNotDeletingDirs):
		return i18n.M("No folders were deleted, because other files failed to transfer. (%s)", words)
	case errors.Is(err, fs.ErrorImmutableModified):
		// i18n: --immutable is an rclone option, which forbids changing files that exist.
		return i18n.M("A file changed, which --immutable doesn't allow. (%s)", words)
	case errors.Is(err, fs.ErrorFileNameTooLong):
		return i18n.M("The name is too long for this remote. (%s)", words)
	case errors.Is(err, fs.ErrorFileTooSmall):
		return i18n.M("The file is too small for this remote's multipart upload. (%s)", words)
	case errors.Is(err, fs.ErrorRangeIgnored):
		return i18n.M("The server sent the whole file instead of the part that was asked for. (%s)", words)
	case errors.Is(err, fs.ErrorNotImplemented):
		return i18n.M("This remote doesn't support that. (%s)", words)
	case errors.Is(err, fs.ErrorCommandNotFound):
		return i18n.M("This remote has no such command. (%s)", words)
	case errors.Is(err, fs.ErrorPermissionDenied), errors.Is(err, os.ErrPermission):
		return i18n.M("You don't have permission to do that. (%s)", words)
	case errors.Is(err, os.ErrNotExist):
		return i18n.M("That file or folder doesn't exist. (%s)", words)
	case diskFull(err):
		return i18n.M("There is no space left on the disk. (%s)", words)
	case fserrors.IsRetryAfterError(err):
		return i18n.M("The service is limiting requests. Try again later. (%s)", words)
	}
	var dns *net.DNSError
	var timeout net.Error
	var op *net.OpError
	switch {
	case errors.As(err, &dns):
		return i18n.M("The server's address couldn't be found. Check the internet connection. (%s)", words)
	case errors.As(err, &timeout) && timeout.Timeout():
		return i18n.M("The server didn't answer in time. Check the internet connection. (%s)", words)
	case errors.Is(err, syscall.ECONNREFUSED):
		return i18n.M("The server refused the connection. (%s)", words)
	case errors.Is(err, syscall.ECONNRESET):
		return i18n.M("The connection to the server was lost. (%s)", words)
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return i18n.M("The server can't be reached. Check the internet connection. (%s)", words)
	case errors.As(err, &op) && op.Op == "dial":
		return i18n.M("Couldn't connect to the server. Check the internet connection. (%s)", words)
	}
	return i18n.Text{}
}
