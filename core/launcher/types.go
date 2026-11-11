package launcher

// Usage is one key's history.
type Usage struct {
	// Key identifies the result (the launcher's Key).
	Key   string `json:"key"`
	Count int64  `json:"count"`
	// LastUsed is when it was last picked, in milliseconds since the epoch.
	LastUsed int64 `json:"lastUsed"`
	// Queries are the last distinct queries that it was picked for, newest first.
	Queries []string `json:"queries"`
}
