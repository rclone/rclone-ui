package db

import (
	"errors"
	"path/filepath"
	"slices"
	"testing"

	"github.com/rclone/rclone-ui/core/internal/testutil"
)

func TestCollect(t *testing.T) {
	d := openT(t, filepath.Join(t.TempDir(), "app.db"))
	scanInt := func(r Scanner) (int, error) {
		var n int
		err := r.Scan(&n)
		return n, err
	}
	query := `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3) SELECT x FROM n`

	rows, err := d.R.QueryContext(ctx(t), query)
	testutil.Must(t, err)
	got, err := Collect(rows, scanInt)
	if err != nil || !slices.Equal(got, []int{1, 2, 3}) {
		t.Errorf("Collect = %v, %v", got, err)
	}

	rows, err = d.R.QueryContext(ctx(t), query+` WHERE x > 5`)
	testutil.Must(t, err)
	if got, err := Collect(rows, scanInt); err != nil || got == nil || len(got) != 0 {
		t.Errorf("no rows: Collect = %#v, %v; want an empty slice", got, err)
	}

	boom := errors.New("boom")
	rows, err = d.R.QueryContext(ctx(t), query)
	testutil.Must(t, err)
	if got, err := Collect(rows, func(r Scanner) (int, error) { return 0, boom }); !errors.Is(err, boom) || got != nil {
		t.Errorf("a failing scan: Collect = %v, %v", got, err)
	}
	if rows.Next() {
		t.Error("the rows were left open after a failing scan")
	}
}
