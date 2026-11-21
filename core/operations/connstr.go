package operations

import (
	"maps"
	"slices"
	"strings"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/fs/fspath"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/location"
)

// fsString returns the Fs string that rclone opens for rel below the root of at. The remote's
// overrides from the remotes group go in its connection string. They are merged over the
// parameters that the path already had, and an override wins, just as a later parameter does in
// rclone's parser.
func fsString(at location.Fs, rel string, overrides map[string]any) (string, error) {
	params := configmap.Simple{}
	for _, key := range slices.Sorted(maps.Keys(overrides)) {
		v := overrides[key]
		if isBlank(v) {
			continue
		}
		if !configParam(key) {
			// i18n: An option's name, then a remote's name.
			return "", errs.Errorf("‘%s’ cannot be an option of %s", key, at.Name)
		}
		text, err := overrideText(v)
		if err != nil {
			// i18n: An option's name, a remote's name, then why the option's value can't be read.
			return "", errs.Errorf("%s of %s: %w", key, at.Name, err)
		}
		params[key] = text
	}
	if len(params) == 0 {
		return at.Config + ":" + at.Anchor + rel, nil
	}
	merged := configmap.Simple{}
	maps.Copy(merged, at.Params)
	maps.Copy(merged, params)
	return at.Name + "," + merged.String() + ":" + at.Anchor + rel, nil
}

// configParam reports whether rclone's parser reads key as a single parameter name. A key that
// could end a value or start a new one would let one option set another.
func configParam(key string) bool {
	parsed, err := fspath.Parse(":x," + key + "=v:")
	return err == nil && len(parsed.Config) == 1 && parsed.Config[key] == "v"
}

// overrideText converts a backend option's value to config text. A list becomes CSV, which is
// how rclone reads the config value of a list option (configstruct.StringToInterface).
func overrideText(v any) (string, error) {
	if list, ok := v.([]any); ok {
		texts := make([]string, len(list))
		for i, e := range list {
			text, err := elementText(e)
			if err != nil {
				return "", err
			}
			texts[i] = text
		}
		return configstruct.InterfaceToString(texts)
	}
	return elementText(v)
}

// checkOverrides refuses an override for the remote of at that rclone would ignore or could not
// parse. rclone reads the connection string keys that it knows and ignores the rest, so a
// misspelled option would silently change nothing.
//
// A valid key is either an option of the remote's backend, or override.<name> for one of
// rclone's main options, which the Fs is opened with (addConfigToContext in fs/newfs.go). Each
// value is parsed by its option's own parser, as the backend will parse it. global.<name> is
// refused, because it changes the options of everything the process runs.
//
// The check reads the config file loaded in this process, so it only applies to a plan, which
// this process opens itself. A mount or serve child reads its own config file, which may be a
// different one.
func checkOverrides(at location.Fs, overrides map[string]any) error {
	var backend *fs.RegInfo
	for _, key := range slices.Sorted(maps.Keys(overrides)) {
		v := overrides[key]
		if isBlank(v) {
			continue
		}
		if backend == nil {
			info, _, _, _, err := fs.ParseRemote(at.Config + ":")
			if err != nil {
				return err
			}
			backend = info
		}
		var opt *fs.Option
		switch name, isOverride := strings.CutPrefix(key, "override."); {
		case isOverride:
			opt = fs.ConfigOptionsInfo.Get(name)
		case strings.HasPrefix(key, "global."):
			return errs.Errorf("‘%s’ would change rclone’s options for everything the app runs; override.%s changes them for %s alone",
				key, strings.TrimPrefix(key, "global."), at.Name)
		default:
			opt = backend.Options.Get(key)
		}
		if opt == nil {
			return errs.Errorf("‘%s’ is not an option of %s (a %s remote)", key, at.Name, backend.Name)
		}
		text, err := overrideText(v)
		if err != nil {
			return errs.Errorf("%s of %s: %w", key, at.Name, err)
		}
		if _, err := configstruct.StringToInterface(opt.GetValue(), text); err != nil {
			return errs.Errorf("%s of %s: %w", key, at.Name, err)
		}
	}
	return nil
}
