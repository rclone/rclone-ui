package operations

import "github.com/rclone/rclone-ui/core/catalog"

// withDefaults returns a copy of g with the app's default options for op (catalog.Defaults) added.
// A default is added only when no option group names the option, under any spelling. A name with
// a null value counts, so a page can turn one of the app's defaults off by sending null for it.
// The remotes group and bisync's outer switches are not option groups, so they don't count.
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
