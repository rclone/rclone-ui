package operations

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/rclone"
)

func TestMain(m *testing.M) {
	slog.SetDefault(slog.New(slog.DiscardHandler))
	testutil.Main(m, func(dir string) error {
		conf := filepath.Join(dir, "rclone.conf")
		if err := os.WriteFile(conf, []byte("[mem]\ntype = memory\n\n[gdrive]\ntype = drive\n\n[sftp]\ntype = sftp\n"), 0o600); err != nil {
			return err
		}
		_, err := rclone.Init(context.Background(), rclone.InitOptions{
			ConfigPath: conf,
			CacheDir:   filepath.Join(dir, "cache"),
			LogLevel:   "CRITICAL",
		})
		return err
	})
}
