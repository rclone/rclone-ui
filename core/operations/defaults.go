package operations

import "github.com/rclone/rclone-ui/core/catalog"

func withDefaults(op Operation, g Groups) Groups {
	out := g.clone()
	named := map[string]bool{}
	for _, group := range g.Named() {
		for key := range group {
			named[catalog.NormalizeOptionName(key)] = true
		}
	}
	for name, defaults := range catalog.Defaults()[string(op)] {
		for key, value := range defaults {
			if named[key] {
				continue
			}
			group := out.named(name)
			if group == nil {
				group = catalog.Group{}
				out.set(name, group)
			}
			group[key] = value
		}
	}
	return out
}
