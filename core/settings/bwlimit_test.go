package settings

import (
	"context"
	"strings"
	"testing"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/internal/testdb"
)

// BwLimit reads one speed, or an upload and a download speed, as --bwlimit does. No limit is ""
// or "off". A timetable or a value rclone can't read is refused, as a field error.
func TestBwLimit(t *testing.T) {
	for in, want := range map[string]string{"10M": "10Mi", " 1M:512k ": "1Mi:512Ki", "": "off", "off": "off", "OFF": "off"} {
		got, err := BwLimit(in)
		if err != nil || got.String() != want {
			t.Errorf("%q: %v %v, want %s", in, got, err, want)
		}
	}
	for _, bad := range []string{"fast", "08:00,512k 19:00,off", "10M,", "-1"} {
		if _, err := BwLimit(bad); err == nil || errs.FieldOf(err) != "transfers.bw_limit" || !strings.HasSuffix(err.Error(), badBwLimit) {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

// Update saves the limit trimmed, refuses a bad one, and tells the OnBwLimit functions about a
// change only.
func TestUpdateBwLimit(t *testing.T) {
	ctx := context.Background()
	s := New(testdb.Open(t), bus.New())
	var got []string
	s.OnBwLimit(func(_ context.Context, limit string) { got = append(got, limit) })
	if st, _, err := s.Update(ctx, Patch{BwLimit: ptr(" 2M ")}); err != nil ||
		st.Transfers.BwLimit != "2M" {
		t.Fatalf("%+v %v", st.Transfers, err)
	}
	if _, _, err := s.Update(ctx, Patch{BwLimit: ptr("fast")}); errs.FieldOf(err) != "transfers.bw_limit" {
		t.Errorf("a bad limit: %v", err)
	}
	if _, _, err := s.Update(ctx, Patch{HideStartup: ptr(true)}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Update(ctx, Patch{BwLimit: ptr("")}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "2M" || got[1] != "" {
		t.Errorf("OnBwLimit got %q", got)
	}
	if st, _ := s.Get(ctx); st.Transfers.BwLimit != "" {
		t.Errorf("saved %q", st.Transfers.BwLimit)
	}
}
