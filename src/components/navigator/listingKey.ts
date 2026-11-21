import {
    currentHost,
    DRIVE_ROOT,
    type Host,
    localParentDir,
    parsePath,
    remoteParentDir,
    SHARE_ROOT,
    separatorOf,
    trailingSeparatorsOf,
} from '../../../lib/paths'

// The keys that identify a folder's listing, which the change notices in `listing.ts` use to
// find the panels to refresh. They live in their own file so they can be tested without a
// window. A key holds the remote (or the local machine) and the folder, exactly as a panel
// stores them. A remote keeps its parameters (`gdrive,shared_with_me`), because with them it
// lists a different place than the remote without them.

export type ListingRemote = string | 'UI_LOCAL_FS'
export type ListingKey = readonly ['listing', ListingRemote, string]

/**
 * Normalizes a folder for a key. Trailing separators are removed, but a root is kept as it is
 * (`` and `/` for a remote, and `/`, `C:\` or `\\nas\share\` locally). A leading slash is also
 * kept, because `remote:/a` is not `remote:a`.
 */
export function normalizeListingDir(dir: string, host: Host = currentHost()): string {
    const trimmed = dir.replace(trailingSeparatorsOf(host), '')
    if (trimmed === '') return dir === '' ? '' : dir[0]!
    if (host.windows && (DRIVE_ROOT.test(trimmed) || SHARE_ROOT.test(trimmed))) {
        return `${trimmed}\\`
    }
    return trimmed
}

export function listingKey(
    remote: ListingRemote,
    dir: string,
    host: Host = currentHost()
): ListingKey {
    return ['listing', remote, normalizeListingDir(dir, host)]
}

/**
 * The listing that a full path *is*: `r:a/b` → `r`, `a/b`; `r:` → `r`, ``; `/tmp/x` → the local
 * machine, `/tmp/x`.
 */
export function listingOf(
    fullPath: string,
    host: Host = currentHost()
): { remote: ListingRemote; dir: string } {
    const parsed = parsePath(fullPath, host)
    if (parsed.kind === 'remote') {
        return { remote: parsed.name + parsed.params, dir: normalizeListingDir(parsed.path, host) }
    }
    return { remote: 'UI_LOCAL_FS', dir: normalizeListingDir(fullPath, host) }
}

/** The listing that *contains* a full path: its parent folder, found the way the panels go up. */
export function parentListingOf(
    fullPath: string,
    host: Host = currentHost()
): { remote: ListingRemote; dir: string } {
    const parsed = parsePath(fullPath, host)
    if (parsed.kind === 'remote') {
        return { remote: parsed.name + parsed.params, dir: remoteParentDir(parsed.path, host) }
    }
    // This uses the same rules as the panels. A root has no parent, and a bare name has no
    // parent folder that a panel could list.
    return { remote: 'UI_LOCAL_FS', dir: normalizeListingDir(localParentDir(fullPath, host), host) }
}

/** Whether a key names the listing of `dir` on `remote`, or of a folder below it. */
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
    // `r:ab` is not under `r:a`. For a folder below, the prefix must end at a separator, unless
    // the prefix is a root, which already ends with one or is empty.
    const separator = separatorOf(host)
    return top === '' || separator.test(top[top.length - 1]!) || separator.test(key[top.length]!)
}
