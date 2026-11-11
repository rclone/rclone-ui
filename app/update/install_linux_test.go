package update

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestInstallAppImage(t *testing.T) {
	dir := t.TempDir()
	img := filepath.Join(dir, "Rclone_UI.AppImage")
	if err := os.WriteFile(img, []byte("old"), 0o750); err != nil {
		t.Fatal(err)
	}
	f := newFeed(t)
	content := artifactBytes(KindAppImage)
	f.stable = f.release("4.0.2", "v1.76.2", KindAppImage, content)
	e := engineFor(f.options(t, "4.0.1"), TypeAppImage, img)
	rel, err := e.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	art, err := e.Download(context.Background(), rel, nil)
	if err != nil {
		t.Fatal(err)
	}
	relaunch, err := e.Install(context.Background(), art)
	if err != nil || relaunch == nil {
		t.Fatalf("Install = %v", err)
	}
	b, err := os.ReadFile(img)
	if err != nil || !bytes.Equal(b, content) {
		t.Errorf("the AppImage holds %d bytes, %v", len(b), err)
	}
	if info, _ := os.Stat(img); info.Mode().Perm() != 0o750|0o111 {
		t.Errorf("mode = %v", info.Mode())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("left behind: %d entries", len(entries))
	}
}
