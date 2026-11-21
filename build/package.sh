#!/usr/bin/env bash
# Packages a build made by build/build.sh (build/bin/<goos>-<goarch>) for its OS. The packages
# go into build/dist, under the file names that every release uses and that its feed and the
# release page link to (build/release's updateFiles and Published), with V the version:
#
#   darwin   Rclone-UI-V-macos-<arm64|x64>.dmg, Rclone-UI-V-macos-<arm64|x64>.app.tar.gz (for
#            updates)
#   windows  Rclone-UI-V-windows-<x64|arm64>-setup.exe (NSIS, also used by updates and WinGet),
#            Rclone-UI-V-windows-<x64|arm64>-portable.zip (a portable copy, updated by hand)
#   linux    Rclone-UI-V-linux-<x86_64|aarch64>.AppImage, Rclone-UI-V-linux-<amd64|arm64>.deb,
#            Rclone-UI-V-linux-<x86_64|aarch64>.rpm
#
# Signing happens when its secrets are set:
#   macOS    APPLE_SIGNING_IDENTITY (codesign), and APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
#            (notarization). Without them the app is signed ad hoc, and only runs on this Mac.
#   Windows  SIGN_COMMAND, a command with %1 for the file (Azure Trusted Signing in a release)
# When APP_RELEASE_CHECK is set (a release build), missing macOS secrets fail the build instead.
# The signatures that updates check are made by build/release, which the release workflow runs.
#
#   GOOS=darwin GOARCH=arm64 build/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."

goos=${GOOS:-$(go env GOOS)}
goarch=${GOARCH:-$(go env GOARCH)}
version=${APP_VERSION:-$(node -p "require('./package.json').version")}
bin=build/bin/$goos-$goarch
dist=build/dist
mkdir -p "$dist"
work=$(mktemp -d)
name="Rclone-UI-$version"
trap 'rm -rf "$work"' EXIT

# wails3 runs on this machine, whatever GOOS/GOARCH the package is for.
wails3() { env -u GOOS -u GOARCH go tool -modfile=tools/go.mod wails3 "$@"; }

# fetch URL SHA256 DEST downloads a pinned file, and fails unless it has that sha256.
fetch() {
    curl -fsSL -o "$3" "$1"
    echo "$2  $3" | sha256sum -c -
}

sign_windows() {
    [ -n "${SIGN_COMMAND:-}" ] || return 0
    local cmd=${SIGN_COMMAND//%1/\"$1\"}
    echo "signing $1"
    eval "$cmd"
}

case $goos in
darwin)
    arch=x64
    [ "$goarch" = arm64 ] && arch=arm64
    app="$work/Rclone UI.app"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cp "$bin/rcui" "$app/Contents/MacOS/rcui"
    sed "s/@VERSION@/$version/g" build/darwin/Info.plist > "$app/Contents/Info.plist"
    cp build/darwin/icons.icns "$app/Contents/Resources/icons.icns"
    cp LICENSE public/THIRD_PARTY_NOTICES.txt "$app/Contents/Resources/"
    printf 'APPL????' > "$app/Contents/PkgInfo"

    notarizing=false
    if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
        notarizing=true
    fi
    # A release that would be signed ad hoc or not notarized fails here. codesign --verify
    # accepts such an app, but Gatekeeper refuses it on every other Mac.
    if [ -n "${APP_RELEASE_CHECK:-}" ] && { [ -z "${APPLE_SIGNING_IDENTITY:-}" ] || ! $notarizing; }; then
        echo "a release is signed and notarized: APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID must all be set" >&2
        exit 1
    fi
    # notarize FILE STAPLED sends FILE to Apple for notarization, then staples the ticket to
    # STAPLED and checks it there. STAPLED is the app that FILE was zipped from, or the dmg itself.
    notarize() {
        echo "notarizing $1"
        xcrun notarytool submit "$1" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
            --team-id "$APPLE_TEAM_ID" --wait
        xcrun stapler staple "$2"
        xcrun stapler validate "$2"
    }
    if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
        # Sign with the hardened runtime. rcui needs no entitlements, because WebKit's processes
        # belong to the system, and the mount and serve child processes are rcui itself.
        codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$app"
        if $notarizing; then
            (cd "$work" && ditto -c -k --keepParent "Rclone UI.app" app.zip)
            notarize "$work/app.zip" "$app"
            # Check Gatekeeper's verdict, as a downloaded copy would get it.
            spctl -a -vv "$app"
        fi
    else
        codesign --force --sign - "$app"
    fi
    codesign --verify --strict "$app"

    # The archive for updates has the bundle at its root (app/update's untarBundle).
    tar -C "$work" -czf "$dist/$name-macos-$arch.app.tar.gz" "Rclone UI.app"

    # The dmg shows the app on the left and Applications on the right.
    wails3 tool package -format dmg -name "Rclone UI" -out "$work" -window-width 660 -window-height 400
    if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
        codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$work/Rclone UI.dmg"
        if $notarizing; then
            notarize "$work/Rclone UI.dmg" "$work/Rclone UI.dmg"
            spctl -a -vv -t open --context context:primary-signature "$work/Rclone UI.dmg"
        fi
    fi
    mv "$work/Rclone UI.dmg" "$dist/$name-macos-$arch.dmg"
    ;;

windows)
    arch=x64
    [ "$goarch" = arm64 ] && arch=arm64
    sign_windows "$bin/rcui.exe"
    sign_windows "$bin/bin/rclone.exe"
    # The WebView2 bootstrapper, for machines without WebView2.
    wails3 generate webview2bootstrapper -dir "$work"
    # WinFsp's installer, unchanged, which is what its license lets the app ship. The installer
    # and the portable zip put it next to rcui.exe as winfsp.msi (core/mounts' WinFspInstaller).
    # The installer installs WinFsp, and the Mount page offers it when it is missing. This is a
    # 2.2 beta, because WinFsp's last stable release (2.1) lacks the security fixes of the 2.2
    # betas.
    fetch https://github.com/winfsp/winfsp/releases/download/v2.2B5/winfsp-2.2.26286.msi \
        293ffb9bcc0b625c85079fe85fa77f8fe98170aba51a02ac9c83d58f6c3b0e2f "$work/winfsp.msi"
    # Windows needs four numbers in FILEVERSION, so a pre-release such as 4.0.0-beta.1 becomes
    # 4.0.0.0.
    # makensis gets full paths. On Windows they are written with \, because its File command
    # finds nothing at a path written with / (C:/a/b.exe). Elsewhere makensis reads /.
    if command -v cygpath >/dev/null; then
        nsisdir() { cygpath -aw "$1"; }
        sep='\'
    else
        nsisdir() { (cd "$1" && pwd); }
        sep=/
    fi
    nsisdefs=(-DVERSION="$version" -DFILEVERSION="${version%%[-+]*}.0" -DARCH="$arch"
        -DBINDIR="$(nsisdir "$bin")"
        -DOUTFILE="$(nsisdir "$dist")$sep$name-windows-$arch-setup.exe"
        -DWEBVIEW2BOOTSTRAPPER="$(nsisdir "$work")${sep}MicrosoftEdgeWebview2Setup.exe"
        -DWINFSPMSI="$(nsisdir "$work")${sep}winfsp.msi")
    if [ -n "${SIGN_COMMAND:-}" ]; then
        # makensis puts the file's path in place of %1 without quotes, so add them here.
        nsisdefs+=(-DSIGNCOMMAND="${SIGN_COMMAND//%1/\"%1\"}")
    fi
    makensis -V3 "${nsisdefs[@]}" build/windows/nsis/project.nsi

    # The portable zip holds one folder, "Rclone UI". Its empty data folder makes the copy
    # portable (core/datadir's Portable): the app keeps its data there, and rclone's config in
    # rclone.conf next to it. It ships the same license files as the installer.
    portable="$work/portable/Rclone UI"
    mkdir -p "$portable/bin" "$portable/data"
    cp "$bin/rcui.exe" "$portable/rcui.exe"
    cp "$bin/bin/rclone.exe" "$portable/bin/rclone.exe"
    cp "$work/winfsp.msi" "$portable/winfsp.msi"
    cp LICENSE "$portable/LICENSE.txt"
    cp public/THIRD_PARTY_NOTICES.txt build/windows/portable/README.txt "$portable/"
    # The zip must keep the empty data folder, which bsdtar does. Windows has it in System32, and
    # it is macOS's tar. Git Bash's own tar is GNU tar, which can't write a zip, so --format zip
    # makes it fail rather than write a tar file under the zip's name.
    zip_tar=tar
    if command -v cygpath >/dev/null; then
        zip_tar="$(cygpath -S)/tar.exe" # System32, in Git Bash's form
    elif command -v bsdtar >/dev/null; then
        zip_tar=bsdtar
    fi
    zip="$(cd "$dist" && pwd -W 2>/dev/null || pwd)/$name-windows-$arch-portable.zip"
    rm -f "$zip"
    (cd "$work/portable" && "$zip_tar" --format zip -cf "$zip" "Rclone UI")
    ;;

linux)
    deb_arch=$goarch
    rpm_arch=x86_64
    image_arch=x86_64
    if [ "$goarch" = arm64 ]; then
        rpm_arch=aarch64
        image_arch=aarch64
    fi
    # nfpm doesn't expand variables in file paths, so the config is filled in for this build.
    sed -e "s|\${VERSION}|$version|g" -e "s|\${GOARCH}|$goarch|g" -e "s|\${BIN}|$bin|g" \
        build/linux/nfpm.yaml > "$work/nfpm.yaml"
    wails3 tool package -format deb -config "$work/nfpm.yaml" -name rcui -out "$work"
    mv "$work/rcui.deb" "$dist/$name-linux-$deb_arch.deb"
    wails3 tool package -format rpm -config "$work/nfpm.yaml" -name rcui -out "$work"
    mv "$work/rcui.rpm" "$dist/$name-linux-$rpm_arch.rpm"

    # The AppImage is only built on Linux. Wails makes the AppDir, and linuxdeploy with its GTK
    # plugin collects GTK 4, WebKitGTK 6.0 and the other libraries that rcui links, which include
    # gtk4-layer-shell. Wails picks the GTK version from what rcui links. Then the license files
    # are added, and linuxdeploy runs on the AppDir again to pack it. The second run keeps the
    # AppRun that it wrapped the first time.
    if [ "$(uname -s)" = Linux ]; then
        # Pin linuxdeploy, because Wails fetches it from its `continuous` release, which can change
        # between builds. Wails writes the AppImage's AppRun itself: a script that starts rcui from
        # usr/lib, where WebKit's sandbox finds its helper programs. The AppImage is built on its
        # own arch, which is the arch that Wails uses in the tool's name.
        if [ "$goarch" = arm64 ]; then
            tool_arch=aarch64
            linuxdeploy_sha256=620095110d693282b8ebeb244a95b5e911cf8f65f76c88b4b47d16ae6346fcff
        else
            tool_arch=x86_64
            linuxdeploy_sha256=c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d
        fi
        mkdir -p "$work/appimage"
        # Wails doesn't download linuxdeploy when this file is already there.
        fetch "https://github.com/linuxdeploy/linuxdeploy/releases/download/1-alpha-20251107-1/linuxdeploy-$tool_arch.AppImage" \
            "$linuxdeploy_sha256" "$work/appimage/linuxdeploy-$tool_arch.AppImage"

        cp build/linux/icons/512x512.png "$work/org.rclone.ui.png"
        sed 's|^Exec=/usr/bin/rcui|Exec=rcui|' build/linux/org.rclone.ui.desktop > "$work/org.rclone.ui.desktop"
        wails3 generate appimage -binary "$bin/rcui" -icon "$work/org.rclone.ui.png" \
            -desktopfile "$work/org.rclone.ui.desktop" -builddir "$work/appimage" -outputdir "$work"
        rm "$work"/*.AppImage
        appdir=$(echo "$work"/appimage/*.AppDir)
        linuxdeploy=$(echo "$work"/appimage/linuxdeploy-*.AppImage)

        # linuxdeploy leaves libgpg-error to the host, but it carries libgcrypt, which needs the
        # libgpg-error that it was built with. With an older host's copy (Ubuntu 24.04), rcui
        # fails to start on a missing symbol.
        if [ -e "$appdir/usr/lib/libgcrypt.so.20" ]; then
            gpg_error=$(ldd "$appdir/usr/lib/libgcrypt.so.20" | awk '$1 == "libgpg-error.so.0" { print $3 }')
            install -m644 "$gpg_error" "$appdir/usr/lib/libgpg-error.so.0"
        fi

        # Add the licenses: the app's license, the licenses of what it is built from, and the
        # copyright files of the system libraries it carries. The copyright files come from the
        # Debian packages that installed those libraries.
        install -Dm644 LICENSE "$appdir/usr/share/doc/rcui/LICENSE"
        install -Dm644 public/THIRD_PARTY_NOTICES.txt "$appdir/usr/share/doc/rcui/THIRD_PARTY_NOTICES.txt"
        find "$appdir/usr/lib" -type f -name '*.so*' -print0 | while IFS= read -r -d '' lib; do
            pkg=$(dpkg -S "*/$(basename "$lib")" 2>/dev/null | head -n1 | cut -d: -f1 | cut -d, -f1) || true
            if [ -n "$pkg" ] && [ -f "/usr/share/doc/$pkg/copyright" ]; then
                install -Dm644 "/usr/share/doc/$pkg/copyright" "$appdir/usr/share/doc/$pkg/copyright"
            fi
        done

        (cd "$work/appimage" && PATH="$PWD:$PATH" NO_STRIP=1 OUTPUT=rcui.AppImage \
            "$linuxdeploy" --appimage-extract-and-run --appdir "$appdir" --output appimage)
        mv "$work/appimage/rcui.AppImage" "$dist/$name-linux-$image_arch.AppImage"
    else
        echo "skipping the AppImage: it's built on Linux" >&2
    fi
    ;;
esac

ls -la "$dist"
