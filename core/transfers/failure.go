package transfers

import (
	"context"
	"strings"

	"github.com/rclone/rclone-ui/core/i18n"
)

// failed reports whether a transfer's error only counts its failed steps (summaryError).
func failed(errText string) bool { return strings.HasSuffix(errText, " operations failed") }

// failureText returns a failed transfer's error as the user should read it. A transfer whose
// steps failed records only how many did ("1 of 1 operations failed"), so the reason is added:
// the first error not tied to a file (general), or else the failed files, with the first one's
// error. It is used alone when only one step ran.
func failureText(err, general i18n.Text, failedFiles int, fileErr string) i18n.Text {
	errText := err.String()
	if !failed(errText) {
		return err
	}
	var reason i18n.Text
	switch {
	case !general.IsZero() && general.String() != errText:
		reason = general
	case failedFiles == 1 && fileErr != "":
		// i18n: Why a transfer failed. The value is the file's error.
		reason = i18n.M("1 file failed: %s", fileErr)
	case failedFiles >= maxFailed && fileErr != "": // the ledger keeps only the first maxFailed
		// i18n: Why a transfer failed. The values are how many files failed at least, and the first one's error.
		reason = i18n.MN("at least %d file failed. The first error: %s", "at least %d files failed. The first error: %s", maxFailed, maxFailed, fileErr)
	case failedFiles > 1 && fileErr != "":
		// i18n: Why a transfer failed. The values are how many files failed, and the first one's error.
		reason = i18n.MN("%d file failed. The first error: %s", "%d files failed. The first error: %s", failedFiles, failedFiles, fileErr)
	}
	switch {
	case reason.IsZero():
		return err
	case strings.HasPrefix(errText, "1 of "):
		return reason
	}
	// i18n: A transfer's error: how many of its steps failed, and why.
	return i18n.M("%s: %s", err, reason)
}

// FailureText returns a failed transfer's error as the user should read it, in a notification or
// a schedule's last error (see failureText).
func (s *Service) FailureText(ctx context.Context, t Transfer) i18n.Text {
	text := t.ErrorText()
	if t.ID == "" || !failed(t.Error) {
		return text
	}
	d, err := s.Get(ctx, t.ID)
	if err != nil {
		s.log.WarnContext(ctx, "reading a failed transfer's errors", "error", err)
		return text
	}
	var general i18n.Text
	if len(d.General) > 0 {
		general = d.General[0].text
	}
	var failedFiles int
	var fileErr string
	if err := s.db.R.QueryRowContext(ctx, `SELECT COUNT(*) FROM transfer_files
		WHERE transfer_id = ? AND outcome = 'failed'`, t.ID).Scan(&failedFiles); err != nil {
		s.log.WarnContext(ctx, "counting a failed transfer's files", "error", err)
	}
	if failedFiles > 0 {
		if err := s.db.R.QueryRowContext(ctx, `SELECT COALESCE(error, '') FROM transfer_files
			WHERE transfer_id = ? AND outcome = 'failed' ORDER BY completed_ms, rowid LIMIT 1`, t.ID).Scan(&fileErr); err != nil {
			s.log.WarnContext(ctx, "reading a failed transfer's first file", "error", err)
		}
	}
	return failureText(text, general, failedFiles, fileErr)
}
