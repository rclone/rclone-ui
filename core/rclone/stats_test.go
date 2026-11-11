package rclone

import (
	"context"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/fstest/mockobject"
)

// TestStatsAreRclones checks that every key Stats reads exists in rclone's stats result and
// reads back what rclone put there, both in this process and as JSON from a child's rc. If an
// rclone upgrade renames a key or changes its type, this test fails, instead of the Transfers
// page or the Dashboard quietly showing a zero.
func TestStatsAreRclones(t *testing.T) {
	ctx := context.Background()
	stats := accounting.NewStats(ctx)
	tr := stats.NewTransferRemoteSize("moving.bin", 100, nil, nil)
	acc := tr.Account(ctx, io.NopCloser(strings.NewReader(strings.Repeat("x", 100))))
	if _, err := io.CopyN(io.Discard, acc, 40); err != nil {
		t.Fatal(err)
	}
	check := stats.NewCheckingTransfer(mockobject.Object("checked.txt"), "checking")
	defer func() {
		check.Done(ctx, nil)
		_ = acc.Close()
		tr.Done(ctx, nil)
	}()

	out, err := stats.RemoteStats(false)
	if err != nil {
		t.Fatal(err)
	}
	keysOf(t, reflect.TypeFor[Stats](), out, "")

	st := ReadStats(out)
	if st.TotalBytes != 100 || st.TotalTransfers != 1 || st.Eta != nil && *st.Eta < 0 {
		t.Errorf("totals: %+v", st)
	}
	if len(st.Transferring) != 1 || st.Transferring[0].Name != "moving.bin" ||
		st.Transferring[0].Size != 100 || st.Transferring[0].Bytes != 40 || st.Transferring[0].Percentage != 40 {
		t.Errorf("transferring: %+v", st.Transferring)
	}
	if len(st.Checking) != 1 || st.Checking[0] != "checked.txt" {
		t.Errorf("checking: %v", st.Checking)
	}

	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	var child Stats
	if err := json.Unmarshal(b, &child); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(child, st) {
		t.Errorf("a child's answer reads %+v, this process's %+v", child, st)
	}
}

// keysOf checks that out has each json key of struct type typ (at path). For slices of structs,
// it checks the first element.
func keysOf(t *testing.T, typ reflect.Type, out rc.Params, path string) {
	t.Helper()
	for f := range typ.Fields() {
		key, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		v, ok := out[key]
		if !ok {
			t.Errorf("rclone's stats have no %s%s", path, key)
			continue
		}
		if f.Type.Kind() == reflect.Slice && f.Type.Elem().Kind() == reflect.Struct {
			list, ok := v.([]rc.Params)
			if !ok || len(list) == 0 {
				t.Errorf("rclone's %s%s is %T, not a list of objects", path, key, v)
				continue
			}
			keysOf(t, f.Type.Elem(), list[0], path+key+"[0].")
		}
	}
}
