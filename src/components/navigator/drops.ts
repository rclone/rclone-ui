import {
    currentHost,
    type Host,
    leadingSeparatorOf,
    localSegments,
    parsePath,
    separatorOf,
} from '../../../lib/paths'
import type { SelectItem } from './types'

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

export function isInside(path: string, folder: string, host: Host = currentHost()): boolean {
    const at = placeOf(path, host)
    const of = placeOf(folder, host)
    if (!at || !of || at.at !== of.at) return false
    return at.names.length > of.names.length && startsWith(at.names, of.names)
}

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
