package operations

import (
	"encoding/json"

	"github.com/rclone/rclone/fs"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/metadatamap"
)

func mapperArgv(v any) []string {
	argv, err := valueOf(fs.SpaceSepList{}, v)
	if err != nil {
		return nil
	}
	return argv.(fs.SpaceSepList)
}

const noMetadata = `Set "metadata": true to use the metadata mapper`

// rclone runs the mapper only when it copies metadata (fs/metadata.go), so without `metadata`
// every rule would silently do nothing.
func checkMapper(config options) error {
	if !hasMapper(config) {
		return nil
	}
	if on, err := valueOf(false, config["metadata"]); err == nil && on == true {
		return nil
	}
	return errs.Field("options."+GroupMetadata, noMetadata)
}

func hasMapper(o options) bool {
	v, ok := o["metadata_mapper"]
	return ok && !isBlank(v) && len(mapperArgv(v)) > 0
}

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
