import { type Host, currentHost, parsePath, remoteParentDir } from '@/lib/paths'

// The keys of the directory listings cache (`listing.ts`), kept apart from the query client so
// they can be tested without a window. A listing is named by the remote (or the local machine)
// and the directory exactly as a panel keeps it.

export type ListingRemote = string | 'UI_LOCAL_FS'
export type ListingKey = readonly ['listing', ListingRemote, string]

const TRAILING_SEPARATORS = /[\\/]+$/
const WINDOWS_DRIVE = /^[a-zA-Z]:$/
const ENDS_WITH_SEPARATOR = /[\\/]$/

/**
 * A directory as one key: trailing separators off, a root kept as it is (`` and `/` for a
 * remote, `/` or `C:\` locally), and a leading slash kept (`remote:/a` is not `remote:a`).
 */
export function normalizeListingDir(dir: string, host: Host = currentHost()): string {
    const trimmed = dir.replace(TRAILING_SEPARATORS, '')
    if (trimmed === '') return dir === '' ? '' : dir[0]!
    if (host.windows && WINDOWS_DRIVE.test(trimmed)) return `${trimmed}\\`
    return trimmed
}

export function listingKey(
    remote: ListingRemote,
    dir: string,
    host: Host = currentHost()
): ListingKey {
    return ['listing', remote, normalizeListingDir(dir, host)]
}

/** The listing a full path *is*: `r:a/b` → `r`, `a/b`; `r:` → `r`, ``; `/tmp/x` → the machine, `/tmp/x`. */
export function listingOf(
    fullPath: string,
    host: Host = currentHost()
): { remote: ListingRemote; dir: string } {
    const parsed = parsePath(fullPath, host)
    if (parsed.kind === 'remote') {
        return { remote: parsed.name, dir: normalizeListingDir(parsed.path, host) }
    }
    return { remote: 'UI_LOCAL_FS', dir: normalizeListingDir(fullPath, host) }
}

/** The listing that *contains* a full path: the folder above it, as the panel climbs to it. */
export function parentListingOf(
    fullPath: string,
    host: Host = currentHost()
): { remote: ListingRemote; dir: string } {
    const parsed = parsePath(fullPath, host)
    if (parsed.kind === 'remote') {
        return { remote: parsed.name, dir: remoteParentDir(parsed.path) }
    }
    return { remote: 'UI_LOCAL_FS', dir: localParent(fullPath, host) }
}

// The same arithmetic as the navigator's `dirname`: `/x` → `/`, `C:\a` → `C:\`, `/a/b` → `/a`.
// A bare name has no folder above it that a panel could list.
function localParent(path: string, host: Host): string {
    const trimmed = path.replace(TRAILING_SEPARATORS, '')
    // A root has nothing above it.
    if (trimmed === '' || (host.windows && WINDOWS_DRIVE.test(trimmed))) {
        return normalizeListingDir(path, host)
    }
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    if (index === -1) return ''
    if (index === 0) return trimmed[0]!
    if (host.windows && index === 2 && WINDOWS_DRIVE.test(trimmed.slice(0, 2))) {
        return trimmed.slice(0, 3)
    }
    return trimmed.slice(0, index)
}

/** Whether a query key names `dir`'s listing on `remote`, or one of a folder below it. */
export function isListingUnder(
    queryKey: readonly unknown[],
    remote: ListingRemote,
    dir: string,
    host: Host = currentHost()
): boolean {
    if (queryKey[0] !== 'listing' || queryKey[1] !== remote) return false
    const key = queryKey[2]
    if (typeof key !== 'string') return false
    const top = normalizeListingDir(dir, host)
    if (key === top) return true
    if (!key.startsWith(top)) return false
    // `r:ab` is not under `r:a`: a folder below ends the prefix at a separator, unless the
    // prefix is a root, which already ends in one or is empty.
    return top === '' || ENDS_WITH_SEPARATOR.test(top) || ENDS_WITH_SEPARATOR.test(key[top.length]!)
}
