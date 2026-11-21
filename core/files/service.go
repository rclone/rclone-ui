// Package files changes entries in place for the pages. It makes folders, renames entries
// without overwriting, and deletes entries. Each action runs in its own stats group and refuses
// to act on a root. Each one reports what it changed, so the listings cache and the panels can
// drop those folders. Actions that may take a long time (renaming or deleting a folder, and batch
// renames) run as recorded transfers instead.
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

// Invalidator drops the cached listings of changed paths. It is the browse package's Lister.
type Invalidator interface {
	InvalidatePaths(paths ...string)
}

// Transfers records the actions that run as transfers or are made at once, so that History lists
// them. It is the transfer service.
type Transfers interface {
	// Start starts a recorded transfer. A transfer that failed to launch is still returned.
	Start(ctx context.Context, r transfers.Spec) (transfers.Started, error)
	// Done records an action that was made at once as an ended transfer.
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

// start starts a recorded transfer for the Commander, given the form of an operation from
// core/operations.
func (s *Service) start(ctx context.Context, f rcops.Form) (transfers.Started, error) {
	return s.transfers.Start(ctx, transfers.Spec{Form: f, Origin: transfers.Origin{Kind: transfers.OriginCommander}})
}

// record records an action that the Commander made at once as an ended transfer. Its form's
// sources are the paths it worked on, and began is when it began. A failure is only logged,
// because the action itself succeeded.
func (s *Service) record(ctx context.Context, f rcops.Form, began time.Time) {
	_, err := s.transfers.Done(ctx, transfers.DoneRequest{
		Form: f, Origin: transfers.Origin{Kind: transfers.OriginCommander}, Began: began,
	})
	if err != nil {
		logs.Logger(logs.CompTransfers, "").ErrorContext(ctx, "recording a Commander action", "operation", f.Operation, "error", err)
	}
}

const rootProblem = "This is the root. Pick an entry inside it."

// place is the entry that an action works on. It holds the Fs of the entry's folder, the entry's
// name in it, and the context for the action's rclone calls. That context belongs to an rclone
// job with its own stats group.
type place struct {
	ctx  context.Context
	f    fs.Fs
	leaf string
	// at is the entry's split path. dir is the entry's folder below at's root, with a trailing
	// slash, or "" for the root. Both are used to build the paths of its siblings.
	at  location.Fs
	dir string
	// names returns the folder's exact names (see exactNames). The items of a batch in the same
	// folder share it. When it is nil, free lists the folder itself.
	names func() (map[string]bool, error)
}

// sibling returns the path of name in the entry's folder. The root is spelled the same way as in
// the entry's path.
func (p *place) sibling(name string) string { return p.at.Entry(p.dir + name) }

// at runs fn on the folder that holds the entry at p, a full path as the panels write it. The
// folder is opened inside an rclone job with its own stats group. That way, an rclone fatal error
// while opening a remote (such as a bad override) becomes the action's error instead of ending
// the core. A path that names no entry returns an errs.Field error for field.
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

// entryOf returns the entry at p. Its path is split into the root that rclone opens and the rest
// (see location.Split), then into the folder below the root and the entry's name.
func entryOf(p, field string) (*place, error) {
	if strings.TrimSpace(p) == "" {
		return nil, errs.Field(field, "A path is missing.")
	}
	if err := location.FieldRefusal(field, p); err != nil {
		return nil, err
	}
	// FieldRefusal has already refused every path that Split can't read.
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

// exactNames returns every name in f's root, spelled exactly as the store spells it.
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

// errFirstPage stops a listing after its first page.
var errFirstPage = errors.New("files: the first page is enough")

// listsAsFolder reports whether dir lists as a folder of f. It reads the first page only, the
// same way rclone.FirstPage does. A bucket backend lists any prefix, so there the page must have
// an entry. A missing folder is not an error.
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

// nameRefusal returns why name can't be used as a new name in the same folder, as a refusal of
// field, or nil if it can.
func nameRefusal(field, name string) error {
	switch {
	case strings.TrimSpace(name) == "":
		return errs.Field(field, "Name cannot be empty")
	case strings.ContainsAny(name, `/\`), name == ".", name == "..":
		return errs.Field(field, `A name cannot contain / or \`)
	}
	return nil
}

// changed tells the listings cache and the pages what changed.
func (s *Service) changed(names, dirs []string) {
	s.inv.InvalidatePaths(names...)
	s.bus.Publish(bus.FilesChanged, bus.FilesChangedData{Names: names, Dirs: dirs})
}

// IsFolder reports whether the entry at path is a folder, for a caller that has only the path,
// such as an agent that renames it. It asks the backend the way free does: for a file first, and
// then for a folder that lists. It fails when nothing is at path.
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
// move each file. A change of case alone goes through a temporary name (MoveFileCaseSafe here,
// or the matching step for a folder), because a store may ignore case without saying so.
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
			return nil // renamed by a transfer, below
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
		// A transfer that failed to launch is still recorded, and its id shows why, as with a
		// batch.
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
// and the move leaves the source where it was. That is how this function detects it. If looking
// up the source fails, the move is treated as done, because it reported success.
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
		// Open the folder before recording a transfer, so a remote that can't be opened is
		// refused now.
		if err := at(ctx, path, "path", func(*place) error { return nil }); err != nil {
			return transfers.Started{}, err
		}
		// A transfer that failed to launch is still recorded, and its id shows why, as with a
		// batch.
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

// batchMax is the most items one batch rename accepts.
const batchMax = 10000

// statsAtOnce is how many rename targets a batch rename looks up at once.
const statsAtOnce = 8

// Item is one rename in a batch.
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

// targetsFree looks up every target of a batch, a few at a time. It refuses the batch when a
// target is taken, or when two items would get the same name in one folder. Two names are the
// same if they match after NFC normalization, which is how macOS and rclone compare names. Names
// that differ only in case are refused on every backend, because a store may ignore case without
// saying so. Errors are returned in this order: other errors first, then a clash, then the taken
// names.
func targetsFree(ctx context.Context, items []Item) error {
	var (
		mu    sync.Mutex
		named = map[string]renaming{}                        // the first item with each name in a folder, by key
		lists = map[string]func() (map[string]bool, error){} // each folder's exact names, listed once
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
						// The first item to need the list creates it, on its own job's context.
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

// renaming is a batch item's current name and its new name.
type renaming struct{ from, to string }

// clashOf returns the error for two batch items that would get the same name in their folder.
func clashOf(a, b renaming) error {
	if norm.NFC.String(a.to) == norm.NFC.String(b.to) {
		return errs.Field("items", "%q and %q would be the same name", a.from, b.from)
	}
	return errs.Field("items", "%q and %q differ only in case, which a provider that ignores case "+
		"treats as one name. Rename them in separate batches.", a.to, b.to)
}
