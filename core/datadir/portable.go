package datadir

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// PortableDir is the folder that makes a copy of the app portable when it is next to the
// executable (see Portable). The portable zip ships it empty.
const PortableDir = "data"

// Portable reports whether this copy of the app is portable, and returns its folder: the
// executable's folder, with symlinks resolved. A copy is portable on Windows when a folder named
// data is next to its executable, as in VS Code's portable mode. A portable copy keeps everything
// in its folder: the app's data in data (Default), and rclone's config in rclone.conf (see
// core/rclone's DefaultConfigPath). The answer is read once, so it stays the same while the
// process runs, even if the folder is created or deleted meanwhile.
func Portable() (root string, ok bool) { return portableOnce() }

var portableOnce = sync.OnceValues(func() (string, bool) {
	exe, err := os.Executable()
	if err != nil {
		return "", false
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return portable(runtime.GOOS, exe, os.Stat)
})

// portable is Portable's rule for the OS goos and the executable exe. stat reads the file system.
// Only Windows has portable copies: the app on macOS is a bundle that the OS may move or copy,
// and on Linux the packages and the AppImage put their files in the system's places.
func portable(goos, exe string, stat func(string) (os.FileInfo, error)) (string, bool) {
	if goos != "windows" || exe == "" {
		return "", false
	}
	root := filepath.Dir(exe)
	info, err := stat(filepath.Join(root, PortableDir))
	if err != nil || !info.IsDir() {
		return "", false
	}
	return root, true
}
