#!/usr/bin/env bash
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
        ;;
esac

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
rclone_version=$(go list -m -f '{{.Version}}' github.com/rclone/rclone)
ldflags+=" -X github.com/rclone/rclone-ui/core/version.App=$version -X github.com/rclone/rclone/fs.Version=$rclone_version"
if [ -n "${POSTHOG_KEY:-}" ]; then
    ldflags+=" -X github.com/rclone/rclone-ui/core/telemetry.Key=$POSTHOG_KEY"
fi

if ! $skip_frontend; then
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
    shim="$(dirname "$out")/bin/rclone.exe"
    echo "building $shim"
    CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
        go build -trimpath -ldflags "-s -w" -o "$shim" ./build/windows/rclone-shim
fi
