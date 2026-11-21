#!/usr/bin/env bash
# Runs the checks that CI runs. They come in three parts, and all three run when none is named.
# The script keeps going after a failure, so one run shows every problem. At the end it fails and
# lists the steps that failed.
#
#   build/check.sh                 # frontend, api and go
#   build/check.sh frontend api    # only these parts
#   build/check.sh --race go       # go test with the race detector
#   build/check.sh bindings        # only the bindings check (build.sh runs it)
#
#   frontend  tsc, biome ci, vitest
#   api       actionlint, go mod tidy -diff (root and tools), the third-party notices, the
#             translations (that locales/ is in step with the code, that Spanish and Chinese
#             are complete, and that every translation keeps its placeholders), that no
#             tracked file still names an old identifier, and the bindings check.
#             In CI, npm run gen replaces the bindings check: the generated code, which
#             includes the launcher's icons, must not change. Outside CI nothing in the tree
#             is regenerated, because the worktree may hold other work in progress.
#   bindings  generates the bindings into a temporary folder and compares them with
#             lib/shell/bindings, so a bound API that changed without npm run gen is caught.
#   go        go vet and go test, build.sh --vet for this machine and for windows/arm64 (the
#             only vet of the launcher's arm64-only files), and the tools' tests
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

# catalogs fails when the translations in locales/ are out of step with the code: a message that
# was added, changed or removed without `npm run i18n`. It runs npm run i18n and compares the
# result with what the tree had. Then it puts the tree's files back, so nothing is left changed.
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

# identifiers fails when a tracked file, other than a Markdown file, holds one of the old
# identifiers. The current ones are org.rclone.ui, Rclone.RcloneUI (on WinGet) and
# github.com/rclone/rclone-ui.
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
    # The shipped languages are complete, and every translation keeps its placeholders.
    run go run ./build/i18n -check
    run identifiers
    # In CI, generated checks the bindings in the tree itself.
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
