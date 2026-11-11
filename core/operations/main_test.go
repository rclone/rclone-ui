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

// TestMain initializes rclone once for the package, with a config file in a temp folder, as the
// core does. The tests run plans on local folders and the memory backend, bisync keeps its
// listings in the temp cache, and nothing from the user's own rclone setup is read. The gdrive
// and sftp remotes exist only for their types, which overrides are checked against. Nothing
// opens them.
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
