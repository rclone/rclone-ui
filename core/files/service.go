package files

import (
	"context"
	"errors"
	"io"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/operations"
	"golang.org/x/text/unicode/norm"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
	"github.com/rclone/rclone-ui/core/internal/ids"
	"github.com/rclone/rclone-ui/core/location"
	"github.com/rclone/rclone-ui/core/logs"
	rcops "github.com/rclone/rclone-ui/core/operations"
	"github.com/rclone/rclone-ui/core/rclone"
	"github.com/rclone/rclone-ui/core/transfers"
)

type Invalidator interface {
	InvalidatePaths(paths ...string)
}

type Transfers interface {
	// Start starts a recorded transfer. A transfer that failed to launch is still returned.
	Start(ctx context.Context, r transfers.Spec) (transfers.Started, error)
	Done(ctx context.Context, r transfers.DoneRequest) (transfers.Started, error)
}

type Service struct {
	bus       *bus.Bus
	inv       Invalidator
	transfers Transfers
}

func New(b *bus.Bus, inv Invalidator, t Transfers) *Service {
	return &Service{bus: b, inv: inv, transfers: t}
}

func (s *Service) start(ctx context.Context, f rcops.Form) (transfers.Started, error) {
	return s.transfers.Start(ctx, transfers.Spec{Form: f, Origin: transfers.Origin{Kind: transfers.OriginCommander}})
}

func (s *Service) record(ctx context.Context, f rcops.Form, began time.Time) {
	_, err := s.transfers.Done(ctx, transfers.DoneRequest{
		Form: f, Origin: transfers.Origin{Kind: transfers.OriginCommander}, Began: began,
	})
	if err != nil {
		logs.Logger(logs.CompTransfers, "").ErrorContext(ctx, "recording a Commander action", "operation", f.Operation, "error", err)
	}
}

const rootProblem = "This is the root. Pick an entry inside it."

type place struct {
	ctx   context.Context
	f     fs.Fs
	leaf  string
	at    location.Fs
	dir   string
	names func() (map[string]bool, error)
}

func (p *place) sibling(name string) string { return p.at.Entry(p.dir + name) }

func at(ctx context.Context, p, field string, fn func(pl *place) error) error {
	pl, err := entryOf(p, field)
	if err != nil {
		return err
	}
	group := rclone.UIGroup("fs", ids.New())
	defer rclone.DeleteGroup(context.WithoutCancel(ctx), group)
	_, err = rclone.Run(ctx, rclone.CallOpts{Group: group}, func(ctx context.Context) error {
		f, err := cache.Get(ctx, pl.at.Root()+pl.dir)
		if err != nil {
			return err
		}
		pl.ctx, pl.f = ctx, f
		return fn(pl)
	})
	return err
}

func entryOf(p, field string) (*place, error) {
	if strings.TrimSpace(p) == "" {
		return nil, errs.Field(field, "A path is missing.")
	}
	if err := location.FieldRefusal(field, p); err != nil {
		return nil, err
	}
	split, _ := location.Split(p)
	dir, leaf := path.Split(split.Rel)
	if leaf == "" || leaf == "." || leaf == ".." {
		return nil, errs.Field(field, rootProblem)
	}
	return &place{at: split, dir: dir, leaf: leaf}, nil
}

// free returns an error when something named name already exists in the place's folder. It asks
// the backend, because the backend matches case the way its store does: on a drive that ignores
// case, it finds `X.txt` when asked for `x.txt`. Comparing exact names from a listing would not.
func (p *place) free(name, field string) error {
	if rcops.CaseOnly(p.leaf, name) {
		// Asking the backend would find the entry itself. So list the exact names, and refuse
		// when the store has both spellings, because MoveCaseInsensitive's second move would
		// replace the other one.
		names := p.names
		if names == nil {
			names = func() (map[string]bool, error) { return exactNames(p.ctx, p.f) }
		}
		exact, err := names()
		if err != nil {
			return err
		}
		if exact[p.leaf] && exact[name] {
			return errs.Field(field, "%q already exists", name)
		}
		return nil
	}
	_, err := p.f.NewObject(p.ctx, name)
	switch {
	case err == nil, errors.Is(err, fs.ErrorIsDir):
		return errs.Field(field, "%q already exists", name)
	case !errors.Is(err, fs.ErrorObjectNotFound) && !errors.Is(err, fs.ErrorDirNotFound):
		return err
	}
	// ftp and the bucket backends return not-found for a folder.
	folder, err := listsAsFolder(p.ctx, p.f, name)
	if err != nil {
		return err
	}
	if folder {
		return errs.Field(field, "%q already exists", name)
	}
	return nil
}

func exactNames(ctx context.Context, f fs.Fs) (map[string]bool, error) {
	names := map[string]bool{}
	add := func(entries fs.DirEntries) error {
		for _, e := range entries {
			names[path.Base(e.Remote())] = true
		}
		return nil
	}
	if listP := f.Features().ListP; listP != nil {
		if err := listP(ctx, "", add); err != nil {
			return nil, err
		}
		return names, nil
	}
	entries, err := f.List(ctx, "")
	if err != nil {
		return nil, err
	}
	return names, add(entries)
}

var errFirstPage = errors.New("files: the first page is enough")

// listsAsFolder reports whether dir lists as a folder of f. A bucket backend lists any prefix, so
// there the page must have an entry. A missing folder is not an error.
func listsAsFolder(ctx context.Context, f fs.Fs, dir string) (bool, error) {
	var (
		entries int
		err     error
	)
	if listP := f.Features().ListP; listP != nil {
		err = listP(ctx, dir, func(page fs.DirEntries) error {
			entries = len(page)
			return errFirstPage
		})
		if errors.Is(err, errFirstPage) {
			err = nil
		}
	} else {
		var page fs.DirEntries
		page, err = f.List(ctx, dir)
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

func nameRefusal(field, name string) error {
	switch {
	case strings.TrimSpace(name) == "":
		return errs.Field(field, "Name cannot be empty")
	case strings.ContainsAny(name, `/\`), name == ".", name == "..":
		return errs.Field(field, `A name cannot contain / or \`)
	}
	return nil
}

func (s *Service) changed(names, dirs []string) {
	s.inv.InvalidatePaths(names...)
	s.bus.Publish(bus.FilesChanged, bus.FilesChangedData{Names: names, Dirs: dirs})
}

// IsFolder reports whether the entry at path is a folder, for a caller that has only the path,
// such as an agent that renames it. It fails when nothing is at path.
func (s *Service) IsFolder(ctx context.Context, path string) (bool, error) {
	folder := false
	err := at(ctx, path, "path", func(p *place) error {
		_, err := p.f.NewObject(p.ctx, p.leaf)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, fs.ErrorIsDir):
			folder = true
			return nil
		case !errors.Is(err, fs.ErrorObjectNotFound) && !errors.Is(err, fs.ErrorDirNotFound):
			return err
		}
		if folder, err = listsAsFolder(p.ctx, p.f, p.leaf); err != nil {
			return err
		}
		if !folder {
			return errs.NotFound("", "%s doesn't exist.", path)
		}
		return nil
	})
	return folder, err
}

// Mkdir makes a folder at path. On a backend that can't have empty folders, it writes an empty
// `.empty` file inside so the folder exists.
func (s *Service) Mkdir(ctx context.Context, path string) error {
	err := at(ctx, path, "path", func(p *place) error {
		if err := p.free(p.leaf, "path"); err != nil {
			return err
		}
		if p.f.Features().CanHaveEmptyDirectories {
			return operations.Mkdir(p.ctx, p.f, p.leaf)
		}
		_, err := operations.Rcat(p.ctx, p.f, p.leaf+"/.empty", io.NopCloser(strings.NewReader("")), time.Now(), nil)
		return err
	})
	if err != nil {
		return err
	}
	s.changed([]string{path}, []string{path})
	return nil
}

// Renamed is the entry's path after a rename, and the transfer that renames it if it is a folder.
type Renamed struct {
	Path, TransferID string
}

// Rename renames the entry at path to newName in its folder. It refuses when newName is taken,
// because rclone's moves would overwrite a file or merge into a folder. A file is renamed at once.
// A folder is renamed by a recorded transfer, because a backend without server-side moves has to
// move each file.
func (s *Service) Rename(ctx context.Context, path string, isDir bool, newName string) (Renamed, error) {
	var moved string
	err := at(ctx, path, "newName", func(p *place) error {
		if err := nameRefusal("newName", newName); err != nil {
			return err
		}
		if err := p.free(newName, "newName"); err != nil {
			return err
		}
		moved = p.sibling(newName)
		if isDir {
			return nil
		}
		if rcops.CaseOnly(p.leaf, newName) {
			return rcops.MoveFileCaseSafe(p.ctx, p.f, p.f, newName, p.leaf)
		}
		return moveUnlessTaken(p, newName)
	})
	if err != nil {
		return Renamed{}, err
	}
	if isDir {
		started, err := s.start(ctx, rcops.RenameArgs{
			Items: []rcops.RenameItem{{Path: path, IsDir: true, NewName: newName}},
		}.Form())
		if started.ID != "" {
			return Renamed{Path: moved, TransferID: started.ID}, nil
		}
		return Renamed{}, err
	}
	s.changed([]string{path, moved}, nil)
	return Renamed{Path: moved}, nil
}

// moveUnlessTaken moves the place's file to newName in the same folder with ignore_existing set,
// like the steps of a rename plan. If a file appeared at newName after free checked, it is kept,
// and the move leaves the source where it was. That is how this function detects it.
func moveUnlessTaken(p *place, newName string) error {
	ctx, ci := fs.AddConfig(p.ctx)
	ci.IgnoreExisting = true
	if err := operations.MoveFile(ctx, p.f, p.f, newName, p.leaf); err != nil {
		return err
	}
	if _, err := p.f.NewObject(p.ctx, p.leaf); err == nil {
		return errs.Field("newName", "%q already exists", newName)
	}
	return nil
}

// Delete deletes a file at once, and records it as an ended "delete" transfer. For a folder, it
// starts a transfer that deletes the folder and everything in it, and returns the transfer. For
// a file, the transfer it returns is empty.
func (s *Service) Delete(ctx context.Context, path string, isDir bool) (transfers.Started, error) {
	if isDir {
		if err := at(ctx, path, "path", func(*place) error { return nil }); err != nil {
			return transfers.Started{}, err
		}
		started, err := s.start(ctx, rcops.FolderArgs{Path: path}.Form())
		if started.ID != "" {
			return started, nil
		}
		return transfers.Started{}, err
	}
	began := time.Now()
	err := at(ctx, path, "path", func(p *place) error {
		o, err := p.f.NewObject(p.ctx, p.leaf)
		if err != nil {
			return err
		}
		return operations.DeleteFile(p.ctx, o)
	})
	if err != nil {
		return transfers.Started{}, err
	}
	s.changed([]string{path}, nil)
	s.record(ctx, rcops.DeleteArgs{Sources: []string{path}}.Form(), began)
	return transfers.Started{}, nil
}

const batchMax = 10000

const statsAtOnce = 8

type Item struct {
	Path    string
	IsDir   bool
	NewName string
}

// BatchRename checks that every target is free, then starts the transfer that renames the items
// and returns it. One taken target refuses the whole batch, because its move would overwrite or
// merge. The transfer is returned even when it failed to launch, because its record shows how
// each rename went.
func (s *Service) BatchRename(ctx context.Context, items []Item) (transfers.Started, error) {
	switch {
	case len(items) == 0:
		return transfers.Started{}, errs.Field("items", "Nothing to rename.")
	case len(items) > batchMax:
		return transfers.Started{}, errs.Field("items", "At most %d items can be renamed at once.", batchMax)
	}
	for _, it := range items {
		if err := nameRefusal("items", it.NewName); err != nil {
			// i18n: A path, then why it can't be renamed to the name given.
			return transfers.Started{}, errs.Field("items", "%s: %s", it.Path, err)
		}
	}
	if err := targetsFree(ctx, items); err != nil {
		return transfers.Started{}, err
	}
	renames := make([]rcops.RenameItem, len(items))
	for i, it := range items {
		renames[i] = rcops.RenameItem{Path: it.Path, IsDir: it.IsDir, NewName: it.NewName}
	}
	started, err := s.start(ctx, rcops.RenameArgs{Items: renames}.Form())
	if started.ID != "" {
		return started, nil
	}
	return transfers.Started{}, err
}

func targetsFree(ctx context.Context, items []Item) error {
	var (
		mu    sync.Mutex
		named = map[string]renaming{}
		lists = map[string]func() (map[string]bool, error){}
		clash error
		taken []error
		first error
		wg    sync.WaitGroup
	)
	sem := make(chan struct{}, statsAtOnce)
	for _, it := range items {
		wg.Go(func() {
			sem <- struct{}{}
			defer func() { <-sem }()
			err := at(ctx, it.Path, "items", func(p *place) error {
				key := p.at.Root() + p.dir + strings.ToLower(norm.NFC.String(it.NewName))
				mu.Lock()
				this := renaming{p.leaf, it.NewName}
				other, seen := named[key]
				if !seen {
					named[key] = this
				} else if clash == nil {
					clash = clashOf(other, this)
				}
				mu.Unlock()
				if seen {
					return nil
				}
				folder := p.at.Root() + p.dir
				p.names = func() (map[string]bool, error) {
					mu.Lock()
					list, ok := lists[folder]
					if !ok {
						list = sync.OnceValues(func() (map[string]bool, error) { return exactNames(p.ctx, p.f) })
						lists[folder] = list
					}
					mu.Unlock()
					return list()
				}
				return p.free(it.NewName, "items")
			})
			mu.Lock()
			defer mu.Unlock()
			var inv *errs.FieldError
			switch {
			case errors.As(err, &inv):
				taken = append(taken, err)
			case err != nil && first == nil:
				first = err
			}
		})
	}
	wg.Wait()
	switch {
	case first != nil:
		return first
	case clash != nil:
		return clash
	}
	switch len(taken) {
	case 0:
		return nil
	case 1:
		return taken[0]
	}
	more := len(taken) - 1
	// i18n: The first refused item of a batch rename, then how many more were refused.
	return errs.FieldText("items", i18n.MN("%s, and %d more", "%s, and %d more", more, taken[0], more))
}

type renaming struct{ from, to string }

func clashOf(a, b renaming) error {
	if norm.NFC.String(a.to) == norm.NFC.String(b.to) {
		return errs.Field("items", "%q and %q would be the same name", a.from, b.from)
	}
	return errs.Field("items", "%q and %q differ only in case, which a provider that ignores case "+
		"treats as one name. Rename them in separate batches.", a.to, b.to)
}
