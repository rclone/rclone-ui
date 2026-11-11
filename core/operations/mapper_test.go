package operations

import (
	"encoding/json"
	"testing"

	"github.com/rclone/rclone-ui/core/catalog"
	"github.com/rclone/rclone-ui/core/errs"
)

// A metadata mapper without `metadata` is refused wherever the options are read: a transfer's
// groups, a purge's config group, a mount's and a serve's command line, and a template. rclone
// would never run it, so its rules would do nothing.
func TestMapperNeedsMetadata(t *testing.T) {
	const mapper = `"metadata_mapper": ["metadata-map", "--map", "a=b"]`
	refused := func(name string, err error) {
		t.Helper()
		if err == nil || err.Error() != noMetadata || errs.FieldOf(err) != "options.metadata" {
			t.Errorf("%s: %v, want the refusal on options.metadata", name, err)
		}
	}
	for _, op := range []Operation{OperationCopy, OperationDelete} {
		_, err := settingsOf(op, groups("metadata", `{`+mapper+`}`))
		refused(string(op), err)
		_, err = settingsOf(op, groups("metadata", `{`+mapper+`, "metadata": false}`))
		refused(string(op)+" with metadata off", err)
	}
	_, err := settingsOf(OperationPurge, groups("config", `{`+mapper+`}`))
	refused("purge", err)
	_, err = MountCommand(MountArgs{Source: "gdrive:", Destination: "/m", Options: groups("metadata", `{`+mapper+`}`)}, MountEnv{OS: "linux"})
	refused("mount", err)
	_, err = ServeCommand(ServeArgs{Type: "webdav", Source: "gdrive:", Options: groups("metadata", `{`+mapper+`}`)}, ServeEnv{})
	refused("serve", err)

	// rclone reads the text "true" as true, and a blank mapper runs nothing.
	for _, g := range []Groups{
		groups("metadata", `{`+mapper+`, "metadata": "true"}`),
		groups("metadata", `{`+mapper+`, "metadata": true}`),
		groups("metadata", `{"metadata_mapper": ""}`),
		groups("metadata", `{"metadata_mapper": []}`),
	} {
		if _, err := settingsOf(OperationCopy, g); err != nil {
			t.Errorf("%+v: %v", g.Metadata, err)
		}
	}
	// A mapper that runs another program needs it too.
	_, err = settingsOf(OperationCopy, groups("config", `{"metadata_mapper": "/opt/bin/mapper -v"}`))
	refused("another program", err)

	err = CheckTemplate([]Operation{OperationMount}, catalog.Group{"metadata_mapper": json.RawMessage(`["metadata-map"]`)})
	if err == nil || errs.FieldOf(err) != "options" {
		t.Errorf("a template: %v", err)
	}
	if err := CheckTemplate([]Operation{OperationCopy}, catalog.Group{
		"metadata_mapper": json.RawMessage(`["metadata-map"]`), "--metadata": json.RawMessage(`true`),
	}); err != nil {
		t.Errorf("a template with metadata: %v", err)
	}
}

// StoreMapper stores the app's own mapper, typed as one text, as the list that the mapping panel
// writes. A list, and a mapper that runs another program, are kept as they are.
func TestStoreMapper(t *testing.T) {
	g := groups(
		"metadata", `{"metadata_mapper": "metadata-map --set \"note=a b\""}`,
		"config", `{"metadata-mapper": "/opt/bin/mapper -v"}`,
	)
	if err := StoreMapper(&g); err != nil {
		t.Fatal(err)
	}
	if got := string(g.Metadata["metadata_mapper"]); got != `["metadata-map","--set","note=a b"]` {
		t.Errorf("own mapper stored as %s", got)
	}
	if got := string(g.Config["metadata-mapper"]); got != `"/opt/bin/mapper -v"` {
		t.Errorf("another program stored as %s", got)
	}
}
