package favorites

type Favorite struct {
	// Path is an rclone path.
	Path string `json:"path"`
	// AddedAt is when it was added, in milliseconds since the epoch.
	AddedAt int64 `json:"addedAt"`
}
