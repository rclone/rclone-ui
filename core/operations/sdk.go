package operations

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"maps"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configstruct"

	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/metadatamap"
)

type jsField struct {
	key   string
	value any
}

type jsObject []jsField

func (o *jsObject) set(path []string, v any) {
	for i := range *o {
		if (*o)[i].key != path[0] {
			continue
		}
		if len(path) == 1 {
			(*o)[i].value = v
			return
		}
		child, _ := (*o)[i].value.(jsObject)
		child.set(path[1:], v)
		(*o)[i].value = child
		return
	}
	if len(path) == 1 {
		*o = append(*o, jsField{path[0], v})
		return
	}
	var child jsObject
	child.set(path[1:], v)
	*o = append(*o, jsField{path[0], child})
}

type sdkCall struct {
	route string
	job   bool
	body  jsObject
}

func (p Plan) sdkCalls(exe string) ([]sdkCall, error) {
	config, err := apiObject(blockMain, options(p.Config), exe)
	if err != nil {
		return nil, err
	}
	filter, err := apiObject(blockFilter, options(p.Filter), exe)
	if err != nil {
		return nil, err
	}
	calls := make([]sdkCall, 0, len(p.Steps))
	for _, s := range p.Steps {
		route, body, err := s.apiCall(p.Bisync)
		if err != nil {
			return nil, err
		}
		if len(config) > 0 {
			body = append(body, jsField{"_config", config})
		}
		if s.Folder() && len(filter) > 0 {
			body = append(body, jsField{"_filter", filter})
		}
		calls = append(calls, sdkCall{route: route, job: true, body: body})
	}
	return calls, nil
}

func (s Step) apiCall(bisync map[string]any) (string, jsObject, error) {
	src, dst := scriptPath(s.Src), scriptPath(s.Dst)
	switch s.Op {
	case OpCopy, OpMove, OpSync:
		body := jsObject{{"srcFs", src}, {"dstFs", dst}}
		if s.CreateEmptySrcDirs {
			body = append(body, jsField{"createEmptySrcDirs", true})
		}
		if s.DeleteEmptySrcDirs {
			body = append(body, jsField{"deleteEmptySrcDirs", true})
		}
		return "/sync/" + s.Op, body, nil
	case OpBisync:
		body := jsObject{{"path1", src}, {"path2", dst}}
		for _, name := range slices.Sorted(maps.Keys(bisync)) {
			body = append(body, jsField{name, rcValue(bisync[name])})
		}
		return "/sync/bisync", body, nil
	case OpCopyFile, OpMoveFile:
		body := jsObject{{"srcFs", src}, {"srcRemote", s.SrcRemote}, {"dstFs", dst}, {"dstRemote", s.DstRemote}}
		return "/operations/" + s.Op, body, nil
	case OpDelete, OpCleanup:
		return "/operations/" + s.Op, jsObject{{"fs", src}}, nil
	case OpDeleteFile, OpPurge:
		return "/operations/" + s.Op, jsObject{{"fs", src}, {"remote", s.SrcRemote}}, nil
	case OpCopyURL:
		return "/operations/copyurl", jsObject{{"fs", dst}, {"remote", s.DstRemote}, {"url", s.URL}}, nil
	}
	return "", nil, fmt.Errorf("a %q step has no API call", s.Op)
}

func sdkMount(a MountArgs, env MountEnv) (sdkCall, error) {
	if env.NFSPort <= 0 {
		env.NFSPort = PlaceholderNFSPort
	}
	m, err := MountCommand(a, env)
	if err != nil {
		return sdkCall{}, err
	}
	body := jsObject{{"fs", scriptPath(m.Source)}, {"mountPoint", m.MountPoint}, {"mountType", m.Args[0]}}
	return withGroups("/mount/mount", body, m.own, m.groups, env.Exe)
}

func sdkServe(a ServeArgs, env ServeEnv) (sdkCall, error) {
	s, err := ServeCommand(a, env)
	if err != nil {
		return sdkCall{}, err
	}
	body := jsObject{{"type", a.Type}, {"fs", scriptPath(s.Source)}}
	call, err := withGroups("/serve/start", body, s.own, s.groups, env.Exe)
	if err != nil {
		return sdkCall{}, err
	}
	// The API's types take the address as one text, which rclone reads as a CSV record when the
	// option is a list.
	for i, f := range call.body {
		if list, ok := f.value.([]string); ok && f.key == "addr" {
			var b strings.Builder
			w := csv.NewWriter(&b)
			if err := w.Write(list); err != nil {
				return sdkCall{}, err
			}
			w.Flush()
			call.body[i].value = strings.TrimSuffix(b.String(), "\n")
		}
	}
	return call, nil
}

func withGroups(route string, body jsObject, own []blockGroup, g Groups, exe string) (sdkCall, error) {
	for _, group := range own {
		params, err := apiParams(group, exe)
		if err != nil {
			return sdkCall{}, err
		}
		body = append(body, params...)
	}
	config, filter, err := mergedGroups("", g, false)
	if err != nil {
		return sdkCall{}, err
	}
	for _, block := range []struct {
		key, name string
		options   options
	}{{"_config", blockMain, config}, {"_filter", blockFilter, filter}} {
		object, err := apiObject(block.name, block.options, exe)
		if err != nil {
			return sdkCall{}, err
		}
		if len(object) > 0 {
			body = append(body, jsField{block.key, object})
		}
	}
	return sdkCall{route: route, body: body}, nil
}

func apiParams(g blockGroup, exe string) (jsObject, error) {
	var out jsObject
	for _, name := range slices.Sorted(maps.Keys(g.options)) {
		v := g.options[name]
		if list, ok := v.([]any); isBlank(v) || ok && len(list) == 0 {
			continue
		}
		option := firstOption(g.blocks, name)
		if option == nil {
			// i18n: An option's name, then the name of the group of options in the form, such as vfs.
			return nil, errs.Errorf("‘%s’ is not one of the %s options", name, g.group)
		}
		value, err := apiValue(option, v, exe)
		if err != nil {
			return nil, err
		}
		if value != nil {
			out = append(out, jsField{option.Name, value})
		}
	}
	return out, nil
}

// apiObject writes options of one of rclone's blocks as the object that the API reads into the
// block's struct (_config or _filter). Its keys are the struct's fields, as in rclone's JSON.
func apiObject(block string, o options, exe string) (jsObject, error) {
	if len(o) == 0 {
		return nil, nil
	}
	paths, err := fieldPaths(block)
	if err != nil {
		return nil, err
	}
	var out jsObject
	for _, name := range slices.Sorted(maps.Keys(o)) {
		v := o[name]
		if list, ok := v.([]any); isBlank(v) || ok && len(list) == 0 {
			continue
		}
		option, ok := blockOption(block, name)
		if !ok || paths[option.Name] == nil {
			// i18n: An option's name, then the name of one of rclone's blocks of options, such as main or filter.
			return nil, errs.Errorf("‘%s’ is not one of rclone's %s options", name, block)
		}
		value, err := apiValue(option, v, exe)
		if err != nil {
			return nil, err
		}
		if value != nil {
			out.set(paths[option.Name], value)
		}
	}
	return out, nil
}

func firstOption(blocks []string, name string) *fs.Option {
	for _, b := range blocks {
		if option, ok := blockOption(b, name); ok {
			return option
		}
	}
	return nil
}

func fieldPaths(block string) (map[string][]string, error) {
	info, ok := fs.OptionsRegistry[block]
	if !ok {
		return nil, fmt.Errorf("rclone's %s options are not linked in", block)
	}
	items, err := configstruct.Items(info.Opt)
	if err != nil {
		return nil, err
	}
	root := reflect.TypeOf(info.Opt).Elem()
	paths := make(map[string][]string, len(items))
	for _, it := range items {
		var path []string
		t := root
		for name := range strings.SplitSeq(it.Field, ".") {
			f, ok := t.FieldByName(name)
			if !ok {
				return nil, fmt.Errorf("rclone's %s options have no field %s", block, it.Field)
			}
			if !f.Anonymous {
				path = append(path, name)
			}
			t = f.Type
		}
		paths[it.Name] = path
	}
	return paths, nil
}

var textUnmarshaler = reflect.TypeFor[json.Unmarshaler]()

func apiValue(option *fs.Option, v any, exe string) (any, error) {
	value, err := valueOf(option.Default, v)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", option.Name, err)
	}
	switch value := value.(type) {
	case fs.Tristate:
		if !value.Valid {
			return nil, nil
		}
		return value.Value, nil
	case fs.SpaceSepList:
		if option.Name == "metadata_mapper" {
			return metadatamap.Runnable(value, exe), nil
		}
	}
	rv := reflect.ValueOf(value)
	if reflect.PointerTo(rv.Type()).Implements(textUnmarshaler) {
		return elementText(v)
	}
	switch rv.Kind() {
	case reflect.Bool:
		return rv.Bool(), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int(), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return rv.Uint(), nil
	case reflect.Float32, reflect.Float64:
		return rv.Float(), nil
	case reflect.String:
		return rv.String(), nil
	case reflect.Slice:
		if rv.Type().Elem().Kind() == reflect.String {
			list := make([]string, rv.Len())
			for i := range list {
				list[i] = rv.Index(i).String()
			}
			return list, nil
		}
	}
	return elementText(v)
}

func sdkProgram(calls []sdkCall, goos, config string) string {
	start := "rclone rcd --rc-no-auth"
	if config != "" {
		start += " --config=" + shellWord(config, goos == "windows")
	}
	var b strings.Builder
	b.WriteString("import createRCDClient from 'rclone-sdk'\n\n")
	b.WriteString("// rclone's API on this computer, started with: " + start + "\n")
	b.WriteString("const rcd = createRCDClient({ baseUrl: 'http://localhost:5572' })\n")
	if slices.ContainsFunc(calls, func(c sdkCall) bool { return c.job }) {
		b.WriteString(waitForJob)
	}
	for _, c := range calls {
		b.WriteString("\n")
		if c.job {
			b.WriteString("await run(\n    rcd.ASYNC(" + jsString(c.route) + ", {\n        body: ")
			writeJS(&b, c.body, 2)
			b.WriteString(",\n    })\n)\n")
			continue
		}
		b.WriteString("const { data, error } = await rcd.POST(" + jsString(c.route) + ", {\n    body: ")
		writeJS(&b, c.body, 1)
		b.WriteString(",\n})\nif (!data) throw new Error(JSON.stringify(error))\n")
		if c.route == "/serve/start" {
			b.WriteString("console.log('Serving on', data.addr)\n")
		}
	}
	return b.String()
}

const waitForJob = `
// Waits for a call that runs in the background, and throws if it fails.
async function run(started: Promise<{ data?: { jobid: number }; error?: unknown }>) {
    const { data, error } = await started
    if (!data) throw new Error(JSON.stringify(error))
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const { data: job } = await rcd.POST('/job/status', { body: { jobid: data.jobid } })
        if (job?.finished) {
            if (!job.success) throw new Error(job.error)
            return
        }
    }
}
`

var jsIdentifier = regexp.MustCompile(`^[A-Za-z_$][\w$]*$`)

func writeJS(b *strings.Builder, v any, level int) {
	switch v := v.(type) {
	case jsObject:
		if len(v) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for _, f := range v {
			key := f.key
			if !jsIdentifier.MatchString(key) {
				key = jsString(key)
			}
			b.WriteString(strings.Repeat("    ", level+1) + key + ": ")
			writeJS(b, f.value, level+1)
			b.WriteString(",\n")
		}
		b.WriteString(strings.Repeat("    ", level) + "}")
	case string:
		b.WriteString(jsString(v))
	case bool:
		b.WriteString(strconv.FormatBool(v))
	case int64:
		b.WriteString(strconv.FormatInt(v, 10))
	case uint64:
		b.WriteString(strconv.FormatUint(v, 10))
	case float64:
		b.WriteString(strconv.FormatFloat(v, 'f', -1, 64))
	case []string:
		texts := make([]string, len(v))
		for i, text := range v {
			texts[i] = jsString(text)
		}
		b.WriteString("[" + strings.Join(texts, ", ") + "]")
	default:
		b.WriteString(jsString(fmt.Sprint(v)))
	}
}

func jsString(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`, "\n", `\n`, "\r", `\r`, "\t", `\t`).Replace(s) + "'"
}
