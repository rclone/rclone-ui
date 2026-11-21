package logs_test

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/internal/late"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/logs"
)

func TestTailAnswersTheNewest(t *testing.T) {
	l, err := logs.Open(logs.Options{Path: filepath.Join(t.TempDir(), "rcui.log")})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	log := slog.New(l.Handler())
	log.Info("one")
	log.Info("two")
	log.Warn("three")
	testutil.Eventually(t, 5*time.Second, "the lines", func() bool {
		t := l.Tail(1)
		return len(t) == 1 && t[0].Message == "three"
	})

	records, err := logs.NewAPI(late.Of(l)).Tail(context.Background(), 2)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range records {
		got = append(got, r.Level+" "+r.Message)
	}
	if len(got) != 2 || got[0] != "info two" || got[1] != "warning three" {
		t.Errorf("Tail(limit 2) = %q", got)
	}
}
