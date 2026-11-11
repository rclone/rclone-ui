package operations

import (
	"encoding/json"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/metadatamap"
)

// mapperArgv converts a metadata_mapper value to argv. A list is used as it is. A hand-typed
// string is split the way rclone splits it (fs.SpaceSepList): on spaces, keeping quoted parts
// together.
func mapperArgv(v any) []string {
	argv, err := valueOf(fs.SpaceSepList{}, v)
	if err != nil {
		return nil
	}
	return argv.(fs.SpaceSepList)
}

const noMetadata = `Set "metadata": true to use the metadata mapper`

// checkMapper refuses a metadata mapper among an operation's main options (config, after the
// groups are merged) when `metadata` isn't on. rclone runs the mapper only when it copies
// metadata (fs/metadata.go), so without it every rule would silently do nothing. A text that
// rclone reads as true, such as "true", counts.
func checkMapper(config options) error {
	if !hasMapper(config) {
		return nil
	}
	if on, err := valueOf(false, config["metadata"]); err == nil && on == true {
		return nil
	}
	return errs.Field("options."+GroupMetadata, noMetadata)
}

// hasMapper reports whether options set a metadata mapper: a program with at least one word.
func hasMapper(o options) bool {
	v, ok := o["metadata_mapper"]
	return ok && !isBlank(v) && len(mapperArgv(v)) > 0
}

// StoreMapper rewrites the app's own metadata mapper in every option group of g, in place, from a
// typed string to the list `["metadata-map", …]` that the page's panel writes. The list has no
// executable path. The running executable is added when a plan runs or a command line is built
// (metadatamap.Runnable), so a saved template always runs the current binary. A mapper that runs
// another program is kept as it is.
func StoreMapper(g *Groups) error {
	for _, name := range optionGroups {
		group := g.named(name)
		o, err := decodeGroup(name, group)
		if err != nil {
			return err
		}
		v, ok := o["metadata_mapper"]
		if !ok {
			continue
		}
		if _, isList := v.([]any); isList {
			continue
		}
		own, ok := metadatamap.Own(mapperArgv(v), "")
		if !ok {
			continue
		}
		raw, err := json.Marshal(own)
		if err != nil {
			return err
		}
		for key := range group {
			if catalog.NormalizeOptionName(key) == "metadata_mapper" {
				group[key] = raw
			}
		}
	}
	return nil
}
