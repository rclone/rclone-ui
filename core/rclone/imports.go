package rclone

import (
	_ "github.com/rclone/rclone/cmd/bisync"
	_ "github.com/rclone/rclone/fs/accounting"
	_ "github.com/rclone/rclone/fs/config"
	_ "github.com/rclone/rclone/fs/operations"
	_ "github.com/rclone/rclone/fs/rc/jobs"
	_ "github.com/rclone/rclone/fs/sync"
	_ "github.com/rclone/rclone/vfs"

	_ "github.com/rclone/rclone/cmd/mountlib"
	_ "github.com/rclone/rclone/cmd/serve/dlna"
	_ "github.com/rclone/rclone/cmd/serve/ftp"
	_ "github.com/rclone/rclone/cmd/serve/http"
	_ "github.com/rclone/rclone/cmd/serve/restic"
	_ "github.com/rclone/rclone/cmd/serve/s3"
	_ "github.com/rclone/rclone/cmd/serve/sftp"
	_ "github.com/rclone/rclone/cmd/serve/webdav"
)
