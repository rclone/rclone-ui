package operations

// rclone's option blocks and backends register themselves when their packages are linked in.
// The app links these packages (main.go), so the tests link them too.
import (
	_ "github.com/rclone/rclone/backend/all"
	_ "github.com/rclone/rclone/cmd/mountlib"
	_ "github.com/rclone/rclone/cmd/serve/dlna"
	_ "github.com/rclone/rclone/cmd/serve/ftp"
	_ "github.com/rclone/rclone/cmd/serve/http"
	_ "github.com/rclone/rclone/cmd/serve/proxy"
	_ "github.com/rclone/rclone/cmd/serve/restic"
	_ "github.com/rclone/rclone/cmd/serve/s3"
	_ "github.com/rclone/rclone/cmd/serve/sftp"
	_ "github.com/rclone/rclone/cmd/serve/webdav"
	_ "github.com/rclone/rclone/fs/filter"
	_ "github.com/rclone/rclone/fs/log"
	_ "github.com/rclone/rclone/fs/rc"
	_ "github.com/rclone/rclone/vfs/vfscommon"
)
