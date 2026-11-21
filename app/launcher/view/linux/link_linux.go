//go:build linux && cgo

package linux

// The app links gtk4-layer-shell, so the dynamic loader loads it with the app, ahead of
// libwayland-client, which GTK loads. The library stands in for some of libwayland's calls, and
// that only works when it is loaded first (see its linking.md). So it can't be loaded at run time
// with dlopen, as the rest of the launcher's libraries are. The calls themselves go through purego
// (platform_linux.go), which finds the library already loaded. The variable below refers to one of
// its functions, so the linker keeps the library even when it drops unused ones (--as-needed).
// CI checks the order of the binary's libraries.

/*
#cgo pkg-config: gtk4-layer-shell-0
#include <gtk4-layer-shell.h>

void *rcui_layer_shell_link = (void *)gtk_layer_is_supported;
*/
import "C"
