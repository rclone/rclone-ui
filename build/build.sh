#!/usr/bin/env bash
# Builds rcui for GOOS/GOARCH (default: this machine) the way releases are built, with the
# frontend embedded and compressed, and with the release tags. CI and local builds both use this
# script, so the tags are defined in one place.
#
#   build/build.sh                  # this machine → build/bin/<goos>-<goarch>/rcui
#   GOOS=windows GOARCH=arm64 build/build.sh
#   build/build.sh --skip-frontend  # reuse app/assets/dist
#   build/build.sh --print-tags     # print the tags for GOOS/GOARCH
#   build/build.sh --vet            # go vet ./... as GOOS/GOARCH builds (embeds app/assets/dist)
#   POSTHOG_KEY=phc_… build/build.sh   # a build that sends usage data (see below)
set -euo pipefail
cd "$(dirname "$0")/.."

skip_frontend=false
mode=build
for arg in "$@"; do
    case $arg in
        --skip-frontend) skip_frontend=true ;;
        --print-tags) mode=print-tags ;;
        --vet) mode=vet ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

goos=${GOOS:-$(go env GOOS)}
goarch=${GOARCH:-$(go env GOARCH)}

# On every platform, embed the pages and leave out rclone's selfupdate, because ours replaces it.
tags=production,noselfupdate
ldflags="-s -w"
cgo=1
exe=rcui
case $goos in
    windows)
        # Mount with WinFsp, which works without cgo. Build a GUI executable. The CLI roles attach
        # to the terminal themselves.
        tags+=,cmount
        ldflags+=" -H windowsgui"
        cgo=0
        exe=rcui.exe
        ;;
    darwin)
        # Needed for the transparent Startup window.
        tags+=,private_mac_apis
        # Target macOS 12 and later. The external linker reads MACOSX_DEPLOYMENT_TARGET. The cgo
        # compiles also get the minimum version as a flag, because Go's build cache hashes
        # CGO_CFLAGS and CGO_LDFLAGS but not that variable. Without the flag, the cache would
        # reuse objects compiled for this Mac's own version.
        export MACOSX_DEPLOYMENT_TARGET=12.0
        export CGO_CFLAGS="${CGO_CFLAGS:--O2 -g} -mmacosx-version-min=12.0"
        export CGO_LDFLAGS="${CGO_LDFLAGS:--O2 -g} -mmacosx-version-min=12.0"
        ;;
    linux)
        # Linux builds need no tag. They use Wails' default stack, GTK 4 with WebKitGTK 6.0, and
        # they link gtk4-layer-shell, so its development files must be installed too.
        ;;
esac

# --print-tags and --vet stop here. They don't read the version, so they need neither node nor
# the module graph.
case $mode in
    print-tags)
        echo "$tags"
        exit 0
        ;;
    vet)
        echo "vetting ./... ($goos/$goarch, tags $tags)"
        CGO_ENABLED=$cgo GOOS=$goos GOARCH=$goarch go vet -tags "$tags" ./...
        exit 0
        ;;
esac

version=${APP_VERSION:-$(node -p "require('./package.json').version")}
# rclone's version is the version of the rclone module. rclone's own releases set fs.Version the
# same way.
rclone_version=$(go list -m -f '{{.Version}}' github.com/rclone/rclone)
ldflags+=" -X github.com/rclone/rclone-ui/core/version.App=$version -X github.com/rclone/rclone/fs.Version=$rclone_version"
# The PostHog key can only add events, so it isn't a secret. A build without it sends nothing.
if [ -n "${POSTHOG_KEY:-}" ]; then
    ldflags+=" -X github.com/rclone/rclone-ui/core/telemetry.Key=$POSTHOG_KEY"
fi

if ! $skip_frontend; then
    # The pages call the Go code through the generated bindings, so a release must not embed
    # bindings that are out of date.
    env -u GOOS -u GOARCH build/check.sh bindings
    npm run build
    env -u GOOS -u GOARCH go -C tools run ./zstdassets -src ../dist -dst ../app/assets/dist
fi

out=build/bin/$goos-$goarch/$exe
mkdir -p "$(dirname "$out")"

if [ "$goos" = windows ]; then
    # Make a .syso with rcui.exe's icon, version and manifest (DPI awareness, common controls).
    # The Go linker picks it up from the main package. It is made for this build and removed
    # afterwards. @FILEVERSION@ needs four numbers, so a pre-release such as 4.0.0-beta.1
    # becomes 4.0.0.0.
    res=$(mktemp -d)
    trap 'rm -rf "$res" rcui_windows_'"$goarch"'.syso' EXIT
    subst=(-e "s/@VERSION@/$version/g" -e "s/@FILEVERSION@/${version%%[-+]*}.0/g")
    sed "${subst[@]}" build/windows/rcui.exe.manifest > "$res/rcui.exe.manifest"
    sed "${subst[@]}" build/windows/info.json > "$res/info.json"
    env -u GOOS -u GOARCH go tool -modfile=tools/go.mod wails3 generate syso -arch "$goarch" -icon build/windows/icon.ico \
        -manifest "$res/rcui.exe.manifest" -info "$res/info.json" -out "rcui_windows_$goarch.syso"
fi

echo "building $out ($goos/$goarch, tags $tags)"
CGO_ENABLED=$cgo GOOS=$goos GOARCH=$goarch \
    go build -trimpath -tags "$tags" -ldflags "$ldflags" -o "$out" .

if [ "$goos" = windows ]; then
    # The console rclone.exe that the installer puts in <install folder>\bin, for the PATH option.
    shim="$(dirname "$out")/bin/rclone.exe"
    echo "building $shim"
    CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
        go build -trimpath -ldflags "-s -w" -o "$shim" ./build/windows/rclone-shim
fi
