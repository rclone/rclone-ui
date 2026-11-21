package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rclone/rclone-ui/core/browse"
	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/operations"
)

// fileTools registers the tools that look at files and folders, and make small changes to them.
// Deleting is a transfer, in transfers.go.
func (s *Server) fileTools() {
	s.listFilesTool()
	s.searchFilesTool()
	s.folderSizeTool()
	s.compareFoldersTool()
	s.publicLinkTool()
	s.readFileTool()
	s.makeFolderTool()
	s.renameTool()
	s.listOptionsTool()
}

// filesLimit is how many entries a list returns when the agent gives no limit. filesLimitMax is
// the most that an agent can ask for.
const (
	filesLimit    = 200
	filesLimitMax = 1000
)

func filesCap(limit int) int {
	if limit <= 0 {
		return filesLimit
	}
	return min(limit, filesLimitMax)
}

// walkFor is how long a search or a folder's count runs before it stops and returns what it has
// found, so that a huge remote can't hold the agent for minutes. A test shortens it.
var walkFor = 30 * time.Second

type filePathIn struct {
	Path string `json:"path" jsonschema:"a remote path such as \"gdrive:Photos/2024\", or an absolute local path"`
}

type fileEntry struct {
	Name string `json:"name"`
	// Path is the entry's full path, which the other tools take as it is.
	Path     string `json:"path"`
	IsFolder bool   `json:"is_folder"`
	// Size is a file's size in bytes. A folder has none, and neither has a file whose remote
	// doesn't know it.
	Size     *int64 `json:"size,omitempty"`
	Modified string `json:"modified,omitempty"`
}

func fileEntryOf(r browse.Row) fileEntry {
	return fileEntry{Name: r.Name, Path: r.Path, IsFolder: r.IsDir, Size: fileSize(r.IsDir, r.Size), Modified: fileTime(r.ModTime)}
}

// fileSize returns a file's size, or nil for a folder or a size that the remote doesn't know (-1).
func fileSize(isDir bool, size int64) *int64 {
	if isDir || size < 0 {
		return nil
	}
	return &size
}

// fileTime returns a row's time as RFC 3339 to the second, which is all that an agent needs.
// It is "" when the remote gave no time: a file on S3, Swift and the other backends where
// reading it costs a request per file.
func fileTime(t string) string {
	parsed, err := time.Parse(time.RFC3339Nano, t)
	if err != nil {
		return t
	}
	return parsed.Format(time.RFC3339)
}

type listFilesIn struct {
	Path  string `json:"path" jsonschema:"the folder to list: \"gdrive:Photos\", \"gdrive:\" for a remote's root, or a local folder such as \"/Users/me/Documents\""`
	Limit int    `json:"limit,omitempty" jsonschema:"the most entries to return: 200 when not given, and at most 1000"`
}

type listFilesOut struct {
	Path    string      `json:"path"`
	Entries []fileEntry `json:"entries"`
	// Total is how many entries the folder has. A folder with more than browse.ListMax is
	// counted up to there.
	Total     int    `json:"total"`
	Truncated bool   `json:"truncated,omitempty"`
	Note      string `json:"note,omitempty"`
}

func (s *Server) listFilesTool() {
	add(s, &mcp.Tool{
		Name: "list_files",
		Description: "Lists the files and folders directly inside one folder (not the ones below them). Each entry has its name, its full path, " +
			"whether it is a folder, a file's size in bytes, and its modification time when the remote reports it cheaply (S3 and Swift don't for files). " +
			"Folders come first, then by name. total counts every entry, and truncated says the limit cut the list: raise the limit, or use search_files.",
		Annotations: reads("List files"),
	}, func(ctx context.Context, in listFilesIn) (listFilesOut, error) {
		rows, capped, err := s.o.APIs.ListRows(ctx, in.Path)
		if err != nil {
			return listFilesOut{}, err
		}
		slices.SortFunc(rows, func(a, b browse.Row) int {
			if a.IsDir != b.IsDir {
				if a.IsDir {
					return -1
				}
				return 1
			}
			return browse.CompareNames(a.Name, b.Name)
		})
		limit := filesCap(in.Limit)
		out := listFilesOut{Path: in.Path, Entries: []fileEntry{}, Total: len(rows), Truncated: len(rows) > limit}
		for _, r := range rows[:min(len(rows), limit)] {
			out.Entries = append(out.Entries, fileEntryOf(r))
		}
		switch {
		case capped:
			out.Note = fmt.Sprintf("The folder has more than %d entries, so only the first %d were read. Use search_files to find names in it.", browse.ListMax, len(rows))
		case out.Truncated:
			out.Note = fmt.Sprintf("These are the first %d of %d entries. Ask with a larger limit (at most %d), or use search_files to find names.", limit, len(rows), filesLimitMax)
		}
		return out, nil
	})
}

type searchFilesIn struct {
	Path  string `json:"path" jsonschema:"the folder to search, with everything below it: \"gdrive:Photos\", \"gdrive:\" or \"/Users/me\""`
	Query string `json:"query" jsonschema:"a part of the names to find, ignoring case, such as \"invoice\" or \".pdf\""`
	Limit int    `json:"limit,omitempty" jsonschema:"the most matches to return: 200 when not given, and at most 1000"`
}

type searchFilesOut struct {
	Path    string      `json:"path"`
	Query   string      `json:"query"`
	Matches []fileEntry `json:"matches"`
	// Truncated is true when there are more matches than the limit.
	Truncated bool `json:"truncated,omitempty"`
	// StoppedEarly is true when the search didn't read the whole folder, so there may be more
	// matches.
	StoppedEarly bool   `json:"stopped_early,omitempty"`
	Note         string `json:"note,omitempty"`
}

func (s *Server) searchFilesTool() {
	add(s, &mcp.Tool{
		Name: "search_files",
		Description: "Finds the files and folders below a folder, at any depth, whose name contains the query, ignoring case. " +
			"Names that start with a dot, and everything inside such folders, are left out. Each match has its full path. " +
			fmt.Sprintf("The search stops after %d seconds on a large remote: stopped_early then says that there may be more matches, so search a smaller folder. ", int(walkFor.Seconds())) +
			"truncated says that there were more matches than the limit.",
		Annotations: reads("Search files"),
	}, func(ctx context.Context, in searchFilesIn) (searchFilesOut, error) {
		limit := filesCap(in.Limit)
		bounded, cancel := context.WithTimeout(ctx, walkFor)
		defer cancel()
		// One match more than the limit tells whether there are more.
		rows, _, err := s.o.APIs.SearchRows(bounded, in.Path, in.Query, limit+1)
		out := searchFilesOut{Path: in.Path, Query: in.Query, Matches: []fileEntry{}}
		switch {
		case errors.Is(err, browse.ErrWalkMax):
			out.StoppedEarly = true
			out.Note = fmt.Sprintf("The search read %d entries and stopped, so there may be more matches. Search a smaller folder.", browse.SearchWalkMax)
		case err != nil && bounded.Err() != nil && ctx.Err() == nil:
			out.StoppedEarly = true
			out.Note = fmt.Sprintf("The search stopped after %s, before it read the whole folder, so there may be more matches. Search a smaller folder.", walkFor)
		case err != nil:
			return searchFilesOut{}, err
		}
		slices.SortFunc(rows, func(a, b browse.Row) int { return browse.CompareNames(a.Path, b.Path) })
		out.Truncated = len(rows) > limit
		for _, r := range rows[:min(len(rows), limit)] {
			out.Matches = append(out.Matches, fileEntryOf(r))
		}
		if out.Truncated {
			out.Note = strings.TrimSpace(fmt.Sprintf("There are more than %d matches. Ask with a larger limit (at most %d), or a more precise query. %s", limit, filesLimitMax, out.Note))
		}
		return out, nil
	})
}

type folderSizeOut struct {
	Path  string `json:"path"`
	Files int64  `json:"files"`
	Bytes int64  `json:"bytes"`
	// Complete is false when the count stopped before the end, so the folder holds more.
	Complete bool   `json:"complete"`
	Note     string `json:"note,omitempty"`
}

func (s *Server) folderSizeTool() {
	add(s, &mcp.Tool{
		Name: "folder_size",
		Description: "Counts the files in a folder and everything below it, and their total size in bytes. " +
			fmt.Sprintf("On a large remote the count stops after %d seconds: complete is then false, and the numbers are what it counted so far.", int(walkFor.Seconds())),
		Annotations: reads("Folder size"),
	}, func(ctx context.Context, in filePathIn) (folderSizeOut, error) {
		bounded, cancel := context.WithTimeout(ctx, walkFor)
		defer cancel()
		size, err := s.o.APIs.CountFolder(bounded, in.Path)
		out := folderSizeOut{Path: in.Path, Files: size.Files, Bytes: size.Bytes, Complete: err == nil}
		switch {
		case err != nil && bounded.Err() != nil && ctx.Err() == nil:
			out.Note = fmt.Sprintf("The count stopped after %s, so the folder holds more than this.", walkFor)
		case err != nil:
			return folderSizeOut{}, err
		}
		return out, nil
	})
}

type compareFoldersIn struct {
	Left  string `json:"left" jsonschema:"one folder, such as \"/Users/me/Photos\""`
	Right string `json:"right" jsonschema:"the other folder, such as \"gdrive:Photos\""`
	Limit int    `json:"limit,omitempty" jsonschema:"the most names in each list: 200 when not given, and at most 1000"`
}

// comparedEntry is a name that only one side of a comparison has.
type comparedEntry struct {
	Name     string `json:"name"`
	IsFolder bool   `json:"is_folder"`
	Size     *int64 `json:"size,omitempty"`
}

// comparedPair is a name that both sides of a comparison have, with what each side holds.
type comparedPair struct {
	Name          string `json:"name"`
	LeftIsFolder  bool   `json:"left_is_folder,omitempty"`
	RightIsFolder bool   `json:"right_is_folder,omitempty"`
	LeftSize      *int64 `json:"left_size,omitempty"`
	RightSize     *int64 `json:"right_size,omitempty"`
	LeftModified  string `json:"left_modified,omitempty"`
	RightModified string `json:"right_modified,omitempty"`
}

type comparedCounts struct {
	OnlyLeft      int `json:"only_left"`
	OnlyRight     int `json:"only_right"`
	Different     int `json:"different"`
	Same          int `json:"same"`
	FoldersInBoth int `json:"folders_in_both"`
}

type compareFoldersOut struct {
	Left      string          `json:"left"`
	Right     string          `json:"right"`
	Counts    comparedCounts  `json:"counts"`
	OnlyLeft  []comparedEntry `json:"only_left"`
	OnlyRight []comparedEntry `json:"only_right"`
	Different []comparedPair  `json:"different"`
	// Truncated is true when a list holds fewer names than its count.
	Truncated bool `json:"truncated,omitempty"`
	// StoppedEarly is true when a folder held more names than the comparison reads.
	StoppedEarly bool   `json:"stopped_early,omitempty"`
	Note         string `json:"note,omitempty"`
}

func (s *Server) compareFoldersTool() {
	add(s, &mcp.Tool{
		Name: "compare_folders",
		Description: "Compares the names directly inside two folders, one level deep: what is only on the left, only on the right, and different. " +
			"A file is the same when both sides have the same hash, and different when the sizes or the hashes differ, when the two remotes share no hash type to check, " +
			"or when one side is a folder. Folders on both sides are only counted, not compared inside: compare them in turn. " +
			"Names that start with a dot are left out. The counts cover every name; the lists stop at the limit (truncated).",
		Annotations: reads("Compare folders"),
	}, func(ctx context.Context, in compareFoldersIn) (compareFoldersOut, error) {
		res, err := s.o.APIs.Browse.Compare(ctx, in.Left, in.Right, false)
		if err != nil {
			return compareFoldersOut{}, err
		}
		limit := filesCap(in.Limit)
		out := compareFoldersOut{
			Left: in.Left, Right: in.Right, StoppedEarly: res.Capped,
			OnlyLeft: []comparedEntry{}, OnlyRight: []comparedEntry{}, Different: []comparedPair{},
		}
		for _, p := range res.Pairs {
			switch {
			case p.Class == browse.OnlyLeft:
				out.Counts.OnlyLeft++
				if len(out.OnlyLeft) < limit {
					out.OnlyLeft = append(out.OnlyLeft, comparedEntry{Name: p.Name, IsFolder: p.Left.IsDir, Size: fileSize(p.Left.IsDir, p.Left.Size)})
				}
			case p.Class == browse.OnlyRight:
				out.Counts.OnlyRight++
				if len(out.OnlyRight) < limit {
					out.OnlyRight = append(out.OnlyRight, comparedEntry{Name: p.Name, IsFolder: p.Right.IsDir, Size: fileSize(p.Right.IsDir, p.Right.Size)})
				}
			case p.Class == browse.SameByHash:
				out.Counts.Same++
			case p.Left.IsDir && p.Right.IsDir:
				out.Counts.FoldersInBoth++
			default:
				out.Counts.Different++
				if len(out.Different) < limit {
					out.Different = append(out.Different, comparedPair{
						Name: p.Name, LeftIsFolder: p.Left.IsDir, RightIsFolder: p.Right.IsDir,
						LeftSize: fileSize(p.Left.IsDir, p.Left.Size), RightSize: fileSize(p.Right.IsDir, p.Right.Size),
						LeftModified: fileTime(p.Left.ModTime), RightModified: fileTime(p.Right.ModTime),
					})
				}
			}
		}
		c := out.Counts
		out.Truncated = c.OnlyLeft > len(out.OnlyLeft) || c.OnlyRight > len(out.OnlyRight) || c.Different > len(out.Different)
		switch {
		case out.StoppedEarly:
			out.Note = fmt.Sprintf("A folder holds more than %d names, so only that many were compared on each side, and some names may be in the wrong list.", browse.CompareMax)
		case out.Truncated:
			out.Note = fmt.Sprintf("A list stops at %d names. Ask with a larger limit (at most %d).", limit, filesLimitMax)
		}
		return out, nil
	})
}

type publicLinkOut struct {
	Path string `json:"path"`
	Link string `json:"link"`
}

// publicLinkTool registers get_public_link. Making a link can share the file on the remote, so
// the tool isn't read-only.
func (s *Server) publicLinkTool() {
	add(s, &mcp.Tool{
		Name: "get_public_link",
		Description: "Makes a public link to a file or folder, on remotes that can make one (such as Google Drive, Dropbox, OneDrive, Box and pCloud), and returns it. " +
			"Anyone who has the link can open the file, so share it only as the user asked. Fails on remotes that can't, such as a local disk.",
		Annotations: changes("Get a public link"),
	}, func(ctx context.Context, in filePathIn) (publicLinkOut, error) {
		link, err := s.o.APIs.Browse.PublicLink(ctx, in.Path)
		if err != nil {
			return publicLinkOut{}, err
		}
		return publicLinkOut{Path: in.Path, Link: link}, nil
	})
}

// readMax is the most bytes of a file that read_file returns, and what it returns unless the
// agent asks for fewer.
const readMax = 256 << 10

type readFileIn struct {
	Path     string `json:"path" jsonschema:"the file to read, such as \"gdrive:Notes/todo.md\" or \"/Users/me/notes.txt\""`
	MaxBytes int    `json:"max_bytes,omitempty" jsonschema:"the most bytes to return: 262144 (256 KiB) when not given, which is also the most"`
}

type readFileOut struct {
	Path string `json:"path"`
	Text string `json:"text"`
	// Size is the whole file's size in bytes, when the remote knows it.
	Size     *int64 `json:"size,omitempty"`
	Modified string `json:"modified,omitempty"`
	// Truncated is true when Text is only the start of the file.
	Truncated bool `json:"truncated,omitempty"`
}

func (s *Server) readFileTool() {
	add(s, &mcp.Tool{
		Name: "read_file",
		Description: "Returns the text of a small text file, such as a note, a config file or a log. " +
			"It reads at most max_bytes (256 KiB when not given, which is also the most): a larger file comes back as its start, with truncated set. " +
			"A file that isn't text (not valid UTF-8, or it holds NUL bytes) is refused.",
		Annotations: reads("Read a file"),
	}, func(ctx context.Context, in readFileIn) (readFileOut, error) {
		limit := readMax
		if in.MaxBytes > 0 {
			limit = min(in.MaxBytes, readMax)
		}
		start, err := s.o.APIs.ReadFile(ctx, in.Path, int64(limit))
		if err != nil {
			return readFileOut{}, err
		}
		data := start.Data
		if !start.Whole {
			data = withoutCutRune(data)
		}
		if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
			return readFileOut{}, errs.New("This file isn't text (it isn't valid UTF-8, or it holds NUL bytes), and read_file reads only text. Copy it to a local folder to open it with a program that reads its type.")
		}
		out := readFileOut{Path: in.Path, Text: string(data), Size: fileSize(false, start.Size), Truncated: !start.Whole}
		if !start.ModTime.IsZero() {
			out.Modified = start.ModTime.Format(time.RFC3339)
		}
		return out, nil
	})
}

// withoutCutRune drops the bytes at the end of data that start a character which the read cut
// off, so that the start of a longer file is still valid UTF-8.
func withoutCutRune(data []byte) []byte {
	for i := len(data) - 1; i >= 0 && i >= len(data)-utf8.UTFMax; i-- {
		if utf8.RuneStart(data[i]) {
			if !utf8.FullRune(data[i:]) {
				return data[:i]
			}
			break
		}
	}
	return data
}

type madeFolder struct {
	Path string `json:"path"`
}

func (s *Server) makeFolderTool() {
	add(s, &mcp.Tool{
		Name: "make_folder",
		Description: "Creates a folder at the path. It fails when something with that name is already there. " +
			"On a remote that can't hold an empty folder (S3 and the other bucket stores), it puts an empty .empty file inside, so that the folder exists.",
		Annotations: changes("Make a folder"),
	}, func(ctx context.Context, in filePathIn) (madeFolder, error) {
		if err := s.o.APIs.Files.Mkdir(ctx, in.Path); err != nil {
			return madeFolder{}, err
		}
		return madeFolder{Path: in.Path}, nil
	})
}

type renameIn struct {
	Path    string `json:"path" jsonschema:"the file or folder to rename, such as \"gdrive:Photos/old.jpg\""`
	NewName string `json:"new_name" jsonschema:"the new name alone, without a folder, such as \"new.jpg\": the entry stays in its folder"`
}

type renamed struct {
	// Path is the entry's new path.
	Path string `json:"path"`
	// TransferID is the transfer that renames a folder, in the background.
	TransferID string `json:"transfer_id,omitempty"`
	Note       string `json:"note,omitempty"`
}

// renameTool registers rename. It finds out whether the path is a folder, which the Commander
// knows from its listing, so that the agent needn't say.
func (s *Server) renameTool() {
	add(s, &mcp.Tool{
		Name: "rename",
		Description: "Renames a file or folder, which stays in its folder. It refuses a name that is taken, so it never overwrites. " +
			"A file is renamed at once. A folder is renamed by a transfer in the background, because some remotes move each file: " +
			"it returns the transfer's id, so follow it with wait_for_transfer. Whatever pointed to the old name, such as a link or another program's setting, stops working.",
		Annotations: destroys("Rename a file or folder"),
	}, func(ctx context.Context, in renameIn) (renamed, error) {
		folder, err := s.o.APIs.Files.IsFolder(ctx, in.Path)
		if err != nil {
			return renamed{}, err
		}
		res, err := s.o.APIs.Files.Rename(ctx, in.Path, folder, in.NewName)
		if err != nil {
			return renamed{}, err
		}
		out := renamed{Path: res.Path, TransferID: res.TransferID}
		if res.TransferID != "" {
			out.Note = "The folder is being renamed in the background. Follow the transfer with wait_for_transfer."
		}
		return out, nil
	})
}

// optionOperations are the operations whose options list_options lists.
var optionOperations = []operations.Operation{
	operations.OperationCopy, operations.OperationMove, operations.OperationSync, operations.OperationBisync,
	operations.OperationDelete, operations.OperationPurge, operations.OperationDownload,
	operations.OperationMount, operations.OperationServe,
}

type listOptionsIn struct {
	Operation string `json:"operation" jsonschema:"copy, move, sync, bisync, delete, purge, download, mount or serve"`
	ServeType string `json:"serve_type,omitempty" jsonschema:"for serve only: the serve's type, such as http or webdav. Without it, every type's options are listed"`
	Search    string `json:"search,omitempty" jsonschema:"only the options whose name or help contains this, ignoring case, such as \"age\" or \"bandwidth\""`
}

type optionInfo struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// Default is the value that a run takes when the option isn't given: the app's own default
	// where it has one, and rclone's otherwise.
	Default string `json:"default,omitempty"`
	// Choices are the values that a choice or flags option takes.
	Choices []string `json:"choices,omitempty"`
	// Help is the first sentence of rclone's help.
	Help string `json:"help"`
}

// optionSection is one group of an operation's options, as its window shows them.
type optionSection struct {
	Name    string       `json:"name"`
	Options []optionInfo `json:"options"`
}

type optionsListed struct {
	Operation string          `json:"operation"`
	Groups    []optionSection `json:"groups"`
}

// listOptionsTool registers list_options. Its groups are those of the operation's form
// (operations.FormSections), the same groups that optionGroupsFor sorts an agent's flat options
// into. The options and their help are rclone's English, whatever the app's language.
func (s *Server) listOptionsTool() {
	add(s, &mcp.Tool{
		Name: "list_options",
		Description: "Lists the rclone options that an operation takes, grouped as its window shows them: each option's name, its type, its default and a line of help. " +
			"Pass options to the other tools by these names, flat, whatever their group. " +
			"Types: bool, int, float, size (\"64M\"), duration (\"30s\", \"1h\"), time, text, list (a JSON array of strings), choice (one of choices), flags (choices joined by commas), tristate (true, false or unset). " +
			"The config group also takes rclone's other per-run options that no window lists, such as max_depth. Use search to narrow the list.",
		Annotations: reads("List rclone options"),
	}, func(ctx context.Context, in listOptionsIn) (optionsListed, error) {
		op := operations.Operation(in.Operation)
		if !slices.Contains(optionOperations, op) {
			return optionsListed{}, errs.New("operation must be one of copy, move, sync, bisync, delete, purge, download, mount or serve.")
		}
		cat, err := s.o.APIs.Catalog.English(ctx)
		if err != nil {
			return optionsListed{}, err
		}
		serve := ""
		if op == operations.OperationServe && in.ServeType != "" {
			serve = in.ServeType
			if !slices.ContainsFunc(cat.Groups, func(g catalog.Section) bool { return g.Name == "serve."+serve }) {
				var types []string
				for _, g := range cat.Groups {
					if t, ok := strings.CutPrefix(g.Name, "serve."); ok {
						types = append(types, t)
					}
				}
				return optionsListed{}, errs.Errorf("serve_type must be one of %s.", strings.Join(types, ", "))
			}
		}
		// FormSections returns nothing for a download, because no template can be for one. Like a
		// purge, a download reads only its config group.
		sections := []operations.FormSection{{Group: operations.GroupConfig, Catalog: []string{operations.GroupConfig}}}
		if op != operations.OperationDownload {
			sections = operations.FormSections(op, serve)
		}
		return optionsListed{Operation: in.Operation, Groups: optionSections(cat, op, sections, in.Search)}, nil
	})
}

// optionSections describes the options of each group of op's form, from the catalog. An option
// that two of a group's catalog groups list (copy and sync list many of the same) is described
// once. Hidden options are left out, and so are those that search doesn't match. A group left
// without options is left out too.
func optionSections(cat catalog.Catalog, op operations.Operation, sections []operations.FormSection, search string) []optionSection {
	blocks := map[string]map[string]*catalog.Option{}
	for i := range cat.Blocks {
		b := &cat.Blocks[i]
		blocks[b.Name] = map[string]*catalog.Option{}
		for j := range b.Options {
			blocks[b.Name][b.Options[j].Name] = &b.Options[j]
		}
	}
	refs := map[string][]catalog.OptionRef{}
	for _, g := range cat.Groups {
		refs[g.Name] = g.Options
	}
	term := strings.ToLower(strings.TrimSpace(search))
	named := catalog.NormalizeOptionName(term)
	defaults := cat.Defaults[string(op)]
	if op == operations.OperationServe {
		defaults = cat.Defaults["serve"]
	}
	out := []optionSection{}
	for _, sec := range sections {
		seen := map[string]bool{}
		group := optionSection{Name: sec.Group, Options: []optionInfo{}}
		for _, from := range sec.Catalog {
			for _, ref := range refs[from] {
				o := blocks[ref.Block][ref.Name]
				if o == nil || o.Hidden || seen[o.Name] {
					continue
				}
				if term != "" && !strings.Contains(o.Name, named) && !strings.Contains(strings.ToLower(o.Help), term) {
					continue
				}
				seen[o.Name] = true
				group.Options = append(group.Options, optionInfoOf(o, defaults[sec.Group][o.Name]))
			}
		}
		if len(group.Options) == 0 {
			continue
		}
		slices.SortFunc(group.Options, func(a, b optionInfo) int { return strings.Compare(a.Name, b.Name) })
		out = append(out, group)
	}
	return out
}

// optionInfoOf describes an option. appDefault is the app's default for it, as JSON, or nil when
// the app keeps rclone's.
func optionInfoOf(o *catalog.Option, appDefault json.RawMessage) optionInfo {
	info := optionInfo{Name: o.Name, Type: string(o.Kind), Default: o.DefaultText, Help: firstSentence(o.Help)}
	if appDefault != nil {
		var text string
		if json.Unmarshal(appDefault, &text) == nil {
			info.Default = text
		} else {
			info.Default = string(appDefault)
		}
	}
	// Only a closed set's choices are listed. The other options' choices are suggestions, such
	// as common sizes, which the type already explains.
	if o.Kind == catalog.KindChoice || o.Kind == catalog.KindFlags {
		for _, c := range o.Choices {
			info.Choices = append(info.Choices, c.Value)
		}
	}
	return info
}

// firstSentence returns the first sentence of rclone's help, or its first line when that ends
// first. Some help runs to several paragraphs, which would make list_options long.
func firstSentence(help string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(help), "\n")
	line = strings.TrimSpace(line)
	for from := 0; ; {
		i := strings.Index(line[from:], ". ")
		if i < 0 {
			return line
		}
		end := from + i + 1
		// An abbreviation's dot doesn't end the sentence.
		if word := strings.ToLower(line[max(0, end-4):end]); !strings.HasSuffix(word, "e.g.") && !strings.HasSuffix(word, "i.e.") && !strings.HasSuffix(word, "etc.") {
			return line[:end]
		}
		from = end
	}
}
