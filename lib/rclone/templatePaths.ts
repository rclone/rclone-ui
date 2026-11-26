import { plural } from '@lingui/core/macro'
import type { Templates } from '../core/types'

export interface TemplatePaths {
    sources?: string[]
    destination?: string
}

export function hasTemplatePaths(paths: TemplatePaths | null | undefined): boolean {
    return !!paths && ((paths.sources?.length ?? 0) > 0 || !!paths.destination)
}

export function applyTemplatePaths(
    current: TemplatePaths,
    incoming: TemplatePaths | null | undefined,
    merge: boolean
): TemplatePaths {
    if (!hasTemplatePaths(incoming)) return current
    const sources = incoming?.sources ?? []
    const next: TemplatePaths = { ...current }
    if (sources.length > 0) {
        next.sources = merge
            ? [...(current.sources ?? []), ...sources.filter((s) => !current.sources?.includes(s))]
            : sources
    }
    if (incoming?.destination && !(merge && current.destination)) {
        next.destination = incoming.destination
    }
    return next
}

export function describeTemplatePaths(paths: TemplatePaths | null | undefined): string | undefined {
    if (!hasTemplatePaths(paths)) return undefined
    const sources = paths?.sources ?? []
    const first = sources[0] ?? ''
    const from =
        sources.length > 1
            ? plural(sources.length - 1, {
                  one: `${first} and # more`,
                  other: `${first} and # more`,
              })
            : first
    return [from, paths?.destination].filter(Boolean).join(' → ')
}

export function pathsFromArgs(args: {
    sources?: string[]
    source?: string
    destination?: string
}): TemplatePaths {
    const sources = args.sources ?? (args.source ? [args.source] : undefined)
    return {
        sources: sources && sources.length > 0 ? sources : undefined,
        destination: args.destination,
    }
}

export function savedPaths(paths: TemplatePaths | undefined): Templates.Paths | null {
    if (!paths || !hasTemplatePaths(paths)) return null
    return { sources: paths.sources ?? [], destination: paths.destination ?? '' }
}
