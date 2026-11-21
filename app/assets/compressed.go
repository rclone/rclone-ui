package assets

import (
	"errors"
	"io/fs"
	"net/http"
	"time"

	"github.com/klauspost/compress/zstd"
)

// newCompressed serves a tree of <file>.zst files (and uncompressed files), decompressing a file
// on each request. A window loads each file once, and caching them would keep the decompressed
// build in memory for as long as the app runs. A folder is reported as not found, so its path is
// treated as a route.
func newCompressed(tree fs.FS, modTime time.Time) http.Handler {
	dec, err := zstd.NewReader(nil, zstd.WithDecoderConcurrency(0))
	if err != nil {
		panic(err) // fails only with invalid options
	}
	load := func(name string) ([]byte, error) {
		packed, err := readFile(tree, name+ZstdSuffix)
		if errors.Is(err, fs.ErrNotExist) {
			return readFile(tree, name)
		}
		if err != nil {
			return nil, err
		}
		return dec.DecodeAll(packed, nil)
	}
	return spa{load: load, modTime: modTime}
}
