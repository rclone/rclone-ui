// Command zstdassets compresses the Vite build for embedding. It empties -dst, then writes every
// file of -src to it as <file>.zst. A file that zstd shrinks by less than a tenth (images, fonts)
// is copied as it is. app/assets serves both kinds. Files and folders whose names start with a dot
// (a Finder .DS_Store that Vite copied from public/) are skipped, so that they aren't embedded in
// every binary.
//
//	go -C tools run ./zstdassets -src ../dist -dst ../app/assets/dist
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/klauspost/compress/zstd"
)

func main() {
	src := flag.String("src", "dist", "the Vite build")
	dst := flag.String("dst", "app/assets/dist", "where the embedded tree goes")
	flag.Parse()
	if err := run(*src, *dst); err != nil {
		log.Fatal(err)
	}
}

func run(src, dst string) error {
	if _, err := os.Stat(filepath.Join(src, "index.html")); err != nil {
		return fmt.Errorf("%s is not a Vite build: %w", src, err)
	}
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	enc, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedBestCompression))
	if err != nil {
		return err
	}
	var raw, packed int64
	err = filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != src && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out := filepath.Join(dst, rel)
		body := data
		if z := enc.EncodeAll(data, nil); len(z) < len(data)*9/10 {
			out, body = out+".zst", z
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		raw += int64(len(data))
		packed += int64(len(body))
		return os.WriteFile(out, body, 0o644)
	})
	if err != nil {
		return err
	}
	fmt.Printf("zstdassets: %s → %s, %.1f MB → %.1f MB\n", src, dst, float64(raw)/1e6, float64(packed)/1e6)
	return nil
}
