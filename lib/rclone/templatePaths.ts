import { plural } from '@lingui/core/macro'
import type { Templates } from '../core/types'

// How a template's paths are applied on a page: added to the page's paths, or replacing them.
// Every page uses these functions, so that the pages can't drift from each other.

/**
 * A page's paths, as a template keeps them. A single-source page uses the first source, and the
 * core refuses a template with several sources for one (templates.Check). A saved template's
 * paths (Templates.Paths) have the same fields.
 */
export interface TemplatePaths {
    sources?: string[]
    destination?: string
}

export function hasTemplatePaths(paths: TemplatePaths | null | undefined): boolean {
    return !!paths && ((paths.sources?.length ?? 0) > 0 || !!paths.destination)
}

/**
 * The page's paths after a template is applied. Merge adds the template's sources that the page
 * doesn't have, and fills an empty destination. Replace swaps both. A template without paths
 * leaves the page's paths as they are, so Replace All doesn't clear them.
 */
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

/** The paths as a card shows them: "a:x and 2 more → b:y". */
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

/** The paths of a page's form, as a template keeps them. */
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

/** A page's paths as a saved template holds them, or null when there are none. */
export function savedPaths(paths: TemplatePaths | undefined): Templates.Paths | null {
    if (!paths || !hasTemplatePaths(paths)) return null
    return { sources: paths.sources ?? [], destination: paths.destination ?? '' }
}
