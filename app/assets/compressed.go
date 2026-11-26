package assets

import (
	"errors"
	"io/fs"
	"net/http"
	"time"

	"github.com/klauspost/compress/zstd"
)

func newCompressed(tree fs.FS, modTime time.Time) http.Handler {
	dec, err := zstd.NewReader(nil, zstd.WithDecoderConcurrency(0))
	if err != nil {
		panic(err)
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
