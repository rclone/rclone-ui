#!/usr/bin/env bash
set -euo pipefail
# Use the physical path, because npm names the root package by it, and build/notices finds the
# root package to skip by comparing the two.
cd -P "$(dirname "$0")/.."

race=false
parts=()
for arg in "$@"; do
    case $arg in
        --race) race=true ;;
        frontend | api | go | bindings) parts+=("$arg") ;;
        *) echo "usage: build/check.sh [--race] [frontend|api|go|bindings]..." >&2; exit 2 ;;
    esac
done
[ ${#parts[@]} -gt 0 ] || parts=(frontend api go)

# Files and folders that this run wrote, which are removed on exit. The expansion guards against
# an empty array, which macOS's bash 3.2 treats as unbound under set -u.
cleanup=()
trap 'rm -rf ${cleanup[@]+"${cleanup[@]}"}' EXIT

failed=()

run() {
    echo "==> $*"
    if ! "$@"; then
        failed+=("$*")
    fi
}

# placeholder gives a production build an app/assets/dist when the pages aren't built. The embed
# in app/assets/embed.go matches nothing in an empty folder, and go list and go vet reject that.
placeholder() {
    [ -z "$(ls -A app/assets/dist 2>/dev/null)" ] || return 0
    mkdir -p app/assets/dist
    echo '<!doctype html><title>build/check.sh placeholder</title>' > app/assets/dist/index.html
    cleanup+=(app/assets/dist/index.html)
}

generated() {
    npm run gen || return 1
    local changed
    changed=$(git status --porcelain -- lib/shell/bindings app/launcher/icons)
    if [ -n "$changed" ]; then
        echo "$changed" >&2
        echo "generated code is out of date: run npm run gen" >&2
        return 1
    fi
}

bindings() {
    local tmp
    tmp=$(mktemp -d)
    cleanup+=("$tmp")
    go tool -modfile=tools/go.mod wails3 generate bindings -clean=true -d "$tmp" -ts || return 1
    if ! diff -r lib/shell/bindings "$tmp"; then
        echo "the bindings are out of date: run npm run gen" >&2
        return 1
    fi
}

catalogs() {
    local before
    before=$(mktemp -d)
    cleanup+=("$before")
    cp -R locales "$before/"
    npm run --silent i18n >/dev/null || return 1
    if ! diff -r "$before/locales" locales; then
        rm -rf locales
        cp -R "$before/locales" locales
        echo "the translations are out of date: run npm run i18n" >&2
        return 1
    fi
}

identifiers() {
    local old=(-e 'com.rclone.ui' -e 'com.rcloneui' -e 'RcloneUI.RcloneUI' -e 'rclone-ui/rclone-ui')
    if git grep -n -F "${old[@]}" -- ':!*.md' ':!build/check.sh'; then
        echo "an old identifier is still used (above)" >&2
        return 1
    fi
}

frontend() {
    run npx tsc --noEmit -p .
    run npx biome ci
    run npx vitest run
}

api() {
    run go tool -modfile=tools/go.mod actionlint
    run go mod tidy -diff
    run go -C tools mod tidy -diff
    placeholder
    run go run ./build/notices -check
    run catalogs
    run go run ./build/i18n -check
    run identifiers
    if [ -n "${CI:-}" ]; then
        run generated
    else
        run bindings
    fi
}

gocheck() {
    local flags=()
    run go vet ./...
    if $race; then
        flags+=(-race)
    fi
    run go test ${flags[@]+"${flags[@]}"} ./...
    placeholder
    run build/build.sh --vet
    run env GOOS=windows GOARCH=arm64 build/build.sh --vet
    run go -C tools test ./zstdassets/...
}

for part in "${parts[@]}"; do
    case $part in
        frontend) frontend ;;
        api) api ;;
        go) gocheck ;;
        bindings) run bindings ;;
    esac
done

if [ ${#failed[@]} -gt 0 ]; then
    echo >&2
    echo "failed:" >&2
    printf '  %s\n' "${failed[@]}" >&2
    exit 1
fi
echo "all checks passed (${parts[*]})"
