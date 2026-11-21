// Rows dragged between the panels can't be dropped onto themselves. A copy or move into the
// folder an item is already in, into the item itself, or into a folder inside it would make
// rclone copy a folder into itself or a file onto itself. Such a drop starts nothing
// (`FilePanel`).

import {
    currentHost,
    type Host,
    leadingSeparatorOf,
    localSegments,
    parsePath,
    separatorOf,
} from '../../../lib/paths'
import type { SelectItem } from './types'

/**
 * Splits a path into the form that drops compare. `at` is the location (this machine, or a remote
 * with its parameters and whether its path starts at `/`), and `names` are the names below it.
 * Trailing separators are ignored. On a Windows host, both separators are accepted and local
 * names are compared without case. Returns null for anything that isn't a path.
 */
function placeOf(path: string, host: Host): { at: string; names: string[] } | null {
    const parsed = parsePath(path, host)
    if (parsed.kind === 'invalid') return null
    if (parsed.kind === 'local') {
        const names = localSegments(parsed.path, host)
        return { at: '', names: host.windows ? names.map((name) => name.toLowerCase()) : names }
    }
    const absolute = leadingSeparatorOf(host).test(parsed.path)
    return {
        at: `${parsed.name}${parsed.params}:${absolute ? '/' : ''}`,
        names: parsed.path.split(separatorOf(host)).filter(Boolean),
    }
}

const startsWith = (names: string[], start: string[]) =>
    start.length <= names.length && start.every((name, i) => name === names[i])

/**
 * Whether `path` is inside `folder`, at any depth. A path isn't inside itself, and `r:ab` isn't
 * inside `r:a`.
 */
export function isInside(path: string, folder: string, host: Host = currentHost()): boolean {
    const at = placeOf(path, host)
    const of = placeOf(folder, host)
    if (!at || !of || at.at !== of.at) return false
    return at.names.length > of.names.length && startsWith(at.names, of.names)
}

/**
 * Whether dropping `items` on the folder `destination` would put one of them onto itself. That
 * is the case when the destination is the folder the item is already in, the item itself, or a
 * folder inside it. A root counts as being inside itself.
 */
export function landsOnItself(
    items: readonly SelectItem[],
    destination: string,
    host: Host = currentHost()
): boolean {
    const to = placeOf(destination, host)
    if (!to) return false
    return items.some((item) => {
        const from = placeOf(item.path, host)
        if (!from || from.at !== to.at) return false
        const folder = from.names.slice(0, -1)
        return (
            startsWith(to.names, from.names) ||
            (to.names.length === folder.length && startsWith(to.names, folder))
        )
    })
}
