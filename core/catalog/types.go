package catalog

import (
	"encoding/json"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/i18n"
)

// Kind is how an option's value is edited.
type Kind string

const (
	KindText        Kind = "text"
	KindBool        Kind = "bool"
	KindTristate    Kind = "tristate"
	KindInt         Kind = "int"
	KindFloat       Kind = "float"
	KindSize        Kind = "size"
	KindDuration    Kind = "duration"
	KindTime        Kind = "time"
	KindChoice      Kind = "choice"
	KindFlags       Kind = "flags"
	KindList        Kind = "list"
	KindFileMode    Kind = "file_mode"
	KindBwTimetable Kind = "bw_timetable"
)

// Path marks an option that holds a path. A file or a folder is a local path. A remote is a path
// that rclone opens as the remote that the backend wraps (an alias's or a crypt's remote), which
// may be another remote's path (remote:path) or a local folder.
type Path string

const (
	PathUnspecified Path = ""
	PathFile        Path = "file"
	PathDir         Path = "dir"
	PathRemote      Path = "remote"
)

type Choice struct {
	Value string `json:"value"`
	Help  string `json:"help"`
}

type Option struct {
	Name string `json:"name"`
	Help string `json:"help"`
	// Groups lists rclone's groups for a global option ("Copy,Performance").
	Groups string `json:"groups"`
	// Type is rclone's type name ("SizeSuffix").
	Type string `json:"type"`
	Kind Kind   `json:"kind"`
	// DefaultText is the default as rclone writes it. Default is the default as rclone's JSON.
	DefaultText string          `json:"defaultText"`
	Default     json.RawMessage `json:"default"`
	Choices     []Choice        `json:"choices"`
	// Exclusive means the value must be one of the choices.
	Exclusive bool   `json:"exclusive"`
	Separator string `json:"separator"`
	Required  bool   `json:"required"`
	Advanced  bool   `json:"advanced"`
	Password  bool   `json:"password"`
	Sensitive bool   `json:"sensitive"`
	Hidden    bool   `json:"hidden"`
	// PerOperation means each run sets its own value, rather than one the process keeps.
	PerOperation bool `json:"perOperation"`
	Path         Path `json:"path"`
}

type Backend struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Prefix      string   `json:"prefix"`
	Aliases     []string `json:"aliases"`
	Hidden      bool     `json:"hidden"`
	Options     []Option `json:"options"`
	// MetadataInfo describes the metadata that the backend keeps, or is nil when it keeps none.
	MetadataInfo *fs.MetadataInfo `json:"metadataInfo"`
}

// Block is one of rclone's option blocks (main, vfs, mount…).
type Block struct {
	Name    string   `json:"name"`
	Options []Option `json:"options"`
}

type OptionRef struct {
	Block string `json:"block"`
	Name  string `json:"name"`
}

type Section struct {
	Name    string      `json:"name"`
	Options []OptionRef `json:"options"`
}

// Catalog is rclone's reference data: its backends, its option blocks, and the sections that the
// forms show. Defaults holds the app's default options (see Defaults), which the pages show in
// their option groups.
type Catalog struct {
	Version  string                      `json:"version"`
	Backends []Backend                   `json:"backends"`
	Blocks   []Block                     `json:"blocks"`
	Groups   []Section                   `json:"groups"`
	Defaults map[string]map[string]Group `json:"defaults"`
}

// BlockValues holds the values of a block's options, as rclone writes them, and the items of
// its list options.
type BlockValues struct {
	Text  map[string]string `json:"text"`
	Lists map[string]*List  `json:"lists"`
}

type List struct {
	Values []string `json:"values"`
}

type Values struct {
	Blocks map[string]*BlockValues `json:"blocks"`
}

type BackendOptions struct {
	Backend  Backend `json:"backend"`
	Provider string  `json:"provider"`
}

type ParsedCommand struct {
	Args []string `json:"args"`
	// Groups holds the options of each catalog group that the command sets.
	Groups  map[string]Group `json:"groups"`
	Skipped []SkippedFlag    `json:"skipped"`
}

type SkippedFlag struct {
	Flag string `json:"flag"`
	// Reason is in English. LocalSkipped gives the app's own reasons in the app's language.
	Reason string `json:"reason"`

	text i18n.Text // Reason as a translatable text, when it is the app's own
}

// Skip returns a skipped flag with one of the app's own reasons, which LocalSkipped translates.
func Skip(flag string, reason i18n.Text) SkippedFlag {
	return SkippedFlag{Flag: flag, Reason: reason.String(), text: reason}
}

// LocalSkipped returns a copy of skipped for a page, with the app's own reasons in the app's
// language. A reason that is rclone's, such as a value it refused, keeps rclone's words. A nil
// list gives an empty one, which the page reads as a list.
func LocalSkipped(skipped []SkippedFlag) []SkippedFlag {
	out := make([]SkippedFlag, len(skipped))
	for i, s := range skipped {
		if !s.text.IsZero() {
			s.Reason = s.text.Local()
		}
		out[i] = s
	}
	return out
}
