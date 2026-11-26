package rclone

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"sync"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/fs/rc"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/logs"
)

var NotPerOperation = []string{
	// These set one limit for the whole process.
	"bwlimit",
	"tpslimit",
	"tpslimit_burst",
	// These are read once, when rclone starts.
	"log_level",
	"max_buffer_memory",
	// These control the command line's retry loop, which transfers run by the app don't have.
	"retries",
	"retries_sleep",
	// These configure a remote's HTTP client and pacer. Whichever call opens the remote first
	// builds them, and they are kept while the remote stays cached, so a value set for one
	// operation is never used.
	"user_agent",
	"timeout",
	"contimeout",
	"expect_continue_timeout",
	"no_gzip_encoding",
	"no_check_certificate",
	"ca_cert",
	"client_cert",
	"client_key",
	"client_pass",
	"disable_http2",
	"disable_http_keep_alives",
	"http_proxy",
	"use_cookies",
	"low_level_retries",
	"max_connections",
}

func PerOperation(name string) bool { return !slices.Contains(NotPerOperation, name) }

var serveTypes = sync.OnceValue(func() []string {
	out, _, err := Call(context.Background(), "serve/types", nil, CallOpts{})
	var types struct {
		Types []string `json:"types"`
	}
	if err == nil {
		err = rc.Reshape(&types, out)
	}
	if err != nil {
		logs.Logger(logs.CompRclone, logs.SubCore).Error("serve types", "error", err)
		return nil
	}
	return types.Types
})

func ServeTypes() []string { return slices.Clone(serveTypes()) }

func IsListType(t reflect.Type) bool {
	return t != nil && t.Kind() == reflect.Slice && t.Elem().Kind() == reflect.String
}

func OptionText(v any) (string, error) {
	switch v := v.(type) {
	case nil:
		return "", nil
	case string:
		return v, nil
	case json.Number:
		return v.String(), nil
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprint(v), nil
	}
	// i18n: Follows an option's name, as in "transfers: takes a text, a number or a switch".
	return "", errs.New("takes a text, a number or a switch")
}

func OptionTexts(v any) ([]string, error) {
	switch v := v.(type) {
	case []string:
		return slices.Clone(v), nil
	case []any:
		out := make([]string, len(v))
		for i, e := range v {
			text, err := OptionText(e)
			if err != nil {
				return nil, err
			}
			out[i] = text
		}
		return out, nil
	}
	// i18n: Follows an option's name, as in "exclude: is not a list".
	return nil, errs.New("is not a list")
}

func ParseOption(template any, v any) (any, error) {
	if template == nil {
		template = "" // this is how rclone reads an option with no default (fs.Options.setValues)
	}
	t := reflect.TypeOf(template)
	switch v.(type) {
	case []string, []any:
		if !IsListType(t) {
			// i18n: Follows an option's name, as in "transfers: takes one value, not a list".
			return nil, errs.New("takes one value, not a list")
		}
		texts, err := OptionTexts(v)
		if err != nil {
			return nil, err
		}
		return reflect.ValueOf(texts).Convert(t).Interface(), nil
	}
	text, err := OptionText(v)
	if err != nil {
		return nil, err
	}
	// Use a temporary, unset option of this type, so that a []string starts empty (Set appends).
	flag := &fs.Option{Default: reflect.Zero(t).Interface()}
	if err := flag.Set(text); err != nil {
		return nil, err
	}
	return flag.GetValue(), nil
}

// configstruct.SetAny isn't used because it turns each value into text and parses it back, which
// isn't exact: a size of 1000 bytes becomes "1000", which is then read as KiB.
func SetFields(opt any, values map[string]any) error {
	items, err := configstruct.Items(opt)
	if err != nil {
		return err
	}
	for _, it := range items {
		v, ok := values[it.Name]
		if !ok {
			continue
		}
		if reflect.TypeOf(v) != reflect.TypeOf(it.Value) {
			return fmt.Errorf("%s: a %T, not a %T", it.Name, v, it.Value)
		}
		it.Set(v)
	}
	return nil
}

// rclone marks some options as secret, but the serves' credentials (pass, salt, auth_key, …) are
// plain strings, so their names are checked too.
func secret(o fs.Option) bool {
	if o.IsPassword || o.Sensitive {
		return true
	}
	switch o.Default.(type) {
	case bool, int, int64, float64:
		return false
	}
	for part := range strings.SplitSeq(o.Name, "_") {
		switch part {
		case "pass", "password", "secret", "token", "salt", "key":
			return true
		}
	}
	return false
}

func optionValueBlocks() []string {
	return append([]string{"main", "filter", "vfs", "mount"}, ServeTypes()...)
}

func OptionValues(ctx context.Context) map[string]map[string]string {
	out := map[string]map[string]string{}
	for _, name := range optionValueBlocks() {
		oi, ok := fs.OptionsRegistry[name]
		if !ok || oi.Opt == nil {
			continue
		}
		values, err := oi.Options.NonDefaultRC(oi.Opt)
		if err != nil {
			logs.Logger(logs.CompRclone, logs.SubCore).DebugContext(ctx, "option values", "block", name, "error", err)
			continue
		}
		block := map[string]string{}
		for i := range oi.Options {
			o := &oi.Options[i]
			v, ok := values[o.FieldName]
			if !ok || secret(*o) {
				continue
			}
			c := o.Copy()
			c.Value = v
			block[o.Name] = c.String()
		}
		if len(block) > 0 {
			out[name] = block
		}
	}
	return out
}
