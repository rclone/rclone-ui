import type { Mounts } from '../../../lib/core/types'
import { parsePath } from '../../../lib/paths'

// An automount's source is a folder of a remote in the config: `remote:folder`, where an empty
// folder is the remote's root.

/**
 * Splits a source into its remote and the folder in it. Returns undefined when the source can't
 * be an automount: a local path, an on-the-fly remote, or a remote with parameters.
 */
export function splitSource(source: string): { remote: string; remotePath: string } | undefined {
    const parsed = parsePath(source)
    if (parsed.kind !== 'remote' || parsed.params || parsed.name.startsWith(':')) return undefined
    return { remote: parsed.name, remotePath: parsed.path }
}

export function sourceOf(a: Pick<Mounts.Automount, 'remote' | 'remotePath'>): string {
    return `${a.remote}:${a.remotePath}`
}
