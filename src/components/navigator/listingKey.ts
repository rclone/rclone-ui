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

export type ListingRemote = string | 'UI_LOCAL_FS'
export type ListingKey = readonly ['listing', ListingRemote, string]

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

export function parentListingOf(
    fullPath: string,
    host: Host = currentHost()
): { remote: ListingRemote; dir: string } {
    const parsed = parsePath(fullPath, host)
    if (parsed.kind === 'remote') {
        return { remote: parsed.name + parsed.params, dir: remoteParentDir(parsed.path, host) }
    }
    return { remote: 'UI_LOCAL_FS', dir: normalizeListingDir(localParentDir(fullPath, host), host) }
}

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
    const separator = separatorOf(host)
    return top === '' || separator.test(top[top.length - 1]!) || separator.test(key[top.length]!)
}
