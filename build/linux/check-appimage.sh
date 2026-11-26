#!/usr/bin/env bash
set -euo pipefail

image=$(realpath "$1")
cd "$(mktemp -d)"
"$image" --appimage-extract > /dev/null
export APPDIR=$PWD/squashfs-root
test -s "$APPDIR/usr/share/doc/rcui/THIRD_PARTY_NOTICES.txt"
for pair in libgtk-4.so.1:libgtk-4-1 libwebkitgtk-6.0.so.4:libwebkitgtk-6.0-4 \
    libgtk4-layer-shell.so.0:libgtk4-layer-shell0; do
    lib=${pair%%:*} pkg=${pair#*:}
    if [ ! -e "$APPDIR/usr/lib/$lib" ] || [ ! -s "$APPDIR/usr/share/doc/$pkg/copyright" ]; then
        echo "the AppImage lacks usr/lib/$lib or usr/share/doc/$pkg/copyright" >&2
        exit 1
    fi
done

if [ -e "$APPDIR/usr/lib/libgcrypt.so.20" ] && [ ! -e "$APPDIR/usr/lib/libgpg-error.so.0" ]; then
    echo "the AppImage carries libgcrypt without libgpg-error" >&2
    exit 1
fi

timeout 30 "$APPDIR/AppRun" version | tee /dev/stderr | grep -q noselfupdate
echo "the AppImage's rcui starts, and its libraries and license files are in it"
