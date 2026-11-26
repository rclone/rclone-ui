package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path"
	"strings"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/cache"
	rcops "github.com/rclone/rclone/fs/operations"
	rcsync "github.com/rclone/rclone/fs/sync"
	"golang.org/x/text/unicode/norm"

	"github.com/rclone/rclone-ui/core/errs"
)

// This is rclone's needsMoveCaseInsensitive without the check of the backend's CaseInsensitive
// flag, because a store may report that flag wrongly. Examples are local on a volume whose case
// handling the OS can't predict, sftp, ftp or webdav to a Mac or Windows machine, and smb with
// case_insensitive=false. On such a store, a plain move finds the source as its own destination
// and deletes it.
func CaseOnly(a, b string) bool {
	return a != b && strings.EqualFold(norm.NFC.String(a), norm.NFC.String(b))
}

func MoveFileCaseSafe(ctx context.Context, fdst, fsrc fs.Fs, dst, src string) (err error) {
	if fdst.Name() != fsrc.Name() || !CaseOnly(path.Join(fsrc.Root(), src), path.Join(fdst.Root(), dst)) {
		return rcops.MoveFile(ctx, fdst, fsrc, dst, src)
	}
	o, err := fsrc.NewObject(ctx, src)
	if err != nil {
		return err
	}
	tr := accounting.Stats(ctx).NewTransfer(o, fdst)
	defer func() { tr.Done(ctx, err) }()
	if _, err = rcops.MoveCaseInsensitive(ctx, fdst, fsrc, dst, src, false, o); err == nil {
		return nil
	}
	// The first move succeeded, so the file now has a temporary name that rclone doesn't report.
	if _, serr := fsrc.NewObject(ctx, src); errors.Is(serr, fs.ErrorObjectNotFound) {
		// i18n: The file's name, the start of its temporary name, its new name, and rclone's error.
		return errs.Errorf("%q was moved to a temporary name starting %q and not renamed to %q: %w",
			src, dst+"-rclone-move-", dst, err)
	}
	return err
}

// operations.Rmdir would count a folder that a server-side move already took away, or one that
// isn't empty, as an error of the transfer.
func removeEmptied(ctx context.Context, f fs.Fs) {
	if !fs.GetConfig(ctx).DryRun {
		_ = f.Rmdir(ctx, "")
	}
}

// When a file appeared at the new name after the rename's checks, rclone keeps that file and
// leaves the source where it was, without an error. A change of case alone isn't checked, because
// the old spelling may find the renamed file.
func renameFile(ctx context.Context, fdst, fsrc fs.Fs, dst, src string) error {
	if err := MoveFileCaseSafe(ctx, fdst, fsrc, dst, src); err != nil {
		return err
	}
	if fs.GetConfig(ctx).DryRun || CaseOnly(path.Join(fsrc.Root(), src), path.Join(fdst.Root(), dst)) {
		return nil
	}
	if _, err := fsrc.NewObject(ctx, src); err == nil {
		return errs.Errorf("%q already exists", path.Base(dst))
	}
	return nil
}

func caseOnlyDirs(src, dst fs.Fs) bool {
	return src.Name() == dst.Name() && CaseOnly(src.Root(), dst.Root())
}

var moveDir = rcsync.MoveDir

func caseOnlyTemp(s Step) string {
	sum := sha256.Sum256([]byte(s.Src + "\x00" + s.Dst))
	return strings.TrimSuffix(s.Dst, "/") + ".rclone-ui-" + hex.EncodeToString(sum[:4])
}

func moveDirCaseOnly(ctx context.Context, s Step, src, dst fs.Fs) error {
	tmp, err := cache.Get(ctx, caseOnlyTemp(s))
	if err != nil {
		return err
	}
	from, via, to := path.Base(src.Root()), path.Base(tmp.Root()), path.Base(dst.Root())
	atSrc, err := holdsAFolder(ctx, src)
	if err != nil {
		return err
	}
	atTmp, err := holdsAFolder(ctx, tmp)
	if err != nil {
		return err
	}
	if atSrc || !atTmp {
		if err := moveDir(ctx, tmp, src, s.DeleteEmptySrcDirs, s.CreateEmptySrcDirs); err != nil {
			// i18n: The folder, its temporary name, and rclone's error.
			return errs.Errorf("%q was partly moved to %q: %w", from, via, err)
		}
		// A file-by-file move leaves the empty folder behind. On a store that ignores case, that
		// folder is dst, so the second move would merge into it under the old spelling.
		removeEmptied(ctx, src)
	}
	if err := moveDir(ctx, dst, tmp, s.DeleteEmptySrcDirs, s.CreateEmptySrcDirs); err != nil {
		// i18n: The folder, its temporary name, its new name, rclone's error, then the temporary and the new name again.
		return errs.Errorf("%q is now %q: renaming it to %q failed: %w. Retry, or rename %q to %q, to finish.",
			from, via, to, err, via, to)
	}
	removeEmptied(ctx, tmp)
	return nil
}

// A bucket backend lists any prefix, so there only a page with an entry counts.
func holdsAFolder(ctx context.Context, f fs.Fs) (bool, error) {
	var (
		entries int
		err     error
	)
	if listP := f.Features().ListP; listP != nil {
		err = listP(ctx, "", func(page fs.DirEntries) error {
			entries = len(page)
			return errFirstPage
		})
		if errors.Is(err, errFirstPage) {
			err = nil
		}
	} else {
		var page fs.DirEntries
		page, err = f.List(ctx, "")
		entries = len(page)
	}
	switch {
	case errors.Is(err, fs.ErrorDirNotFound):
		return false, nil
	case err != nil:
		return false, err
	}
	return entries > 0 || !f.Features().BucketBased, nil
}

var errFirstPage = errors.New("operations: the first page is enough")
