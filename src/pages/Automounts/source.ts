import type { Mounts } from '../../../lib/core/types'
import { parsePath } from '../../../lib/paths'

export function splitSource(source: string): { remote: string; remotePath: string } | undefined {
    const parsed = parsePath(source)
    if (parsed.kind !== 'remote' || parsed.params || parsed.name.startsWith(':')) return undefined
    return { remote: parsed.name, remotePath: parsed.path }
}

export function sourceOf(a: Pick<Mounts.Automount, 'remote' | 'remotePath'>): string {
    return `${a.remote}:${a.remotePath}`
}
