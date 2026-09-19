import type { Template, TemplatePaths } from '../../types/template'

/**
 * What a template's paths mean when it is applied.
 *
 * A template carries where an operation runs as well as how: a list of sources, because copy,
 * move, delete and purge take several, and a destination. Applying one asks the same question it
 * has always asked about the flags — add to what is there, or replace it — and this is the only
 * place that answers it for the paths, so the eight operation pages cannot drift from each other.
 */

/** The operations whose page takes more than one source, as copy, move, delete and purge all do. */
export const MULTI_SOURCE_OPERATIONS = new Set<Template['tags'][number]>([
    'copy',
    'move',
    'delete',
    'purge',
])

export function hasTemplatePaths(paths: TemplatePaths | undefined): boolean {
    return !!paths && ((paths.sources?.length ?? 0) > 0 || !!paths.destination)
}

/**
 * The paths a page should end up with. A template that carries nothing leaves the page exactly as
 * it is, whichever button was pressed: `Replace All` must not wipe the paths someone has just
 * picked.
 */
export function applyTemplatePaths(
    current: TemplatePaths,
    incoming: TemplatePaths | undefined,
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

/** What to tell someone applying a many-source template to a page that takes one, if anything. */
export function extraSourcesNote(
    paths: TemplatePaths | undefined,
    operation: Template['tags'][number]
): string | undefined {
    const count = paths?.sources?.length ?? 0
    if (count < 2 || MULTI_SOURCE_OPERATIONS.has(operation)) return undefined
    return `This template has ${count} sources; ${operation} uses the first.`
}

/** The paths in one line, for a template's card and the drawer. */
export function describeTemplatePaths(paths: TemplatePaths | undefined): string | undefined {
    if (!hasTemplatePaths(paths)) return undefined
    const sources = paths?.sources ?? []
    const from =
        sources.length > 1 ? `${sources[0]} and ${sources.length - 1} more` : (sources[0] ?? '')
    return [from, paths?.destination].filter(Boolean).join(' → ')
}

/**
 * The paths out of an operation's own arguments, whichever shape they take (`sources` on copy and
 * move, `source` everywhere else). What a run kept as a template ran on.
 */
export function pathsFromArgs(args: {
    sources?: string[]
    source?: string
    destination?: string
}): TemplatePaths {
    const sources = args.sources ?? (args.source ? [args.source] : undefined)
    return { sources: sources?.length ? sources : undefined, destination: args.destination }
}
