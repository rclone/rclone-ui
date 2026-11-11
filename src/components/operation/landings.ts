import { plural, t } from '@lingui/core/macro'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounce } from 'use-debounce'
import { transfers as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Operations } from '../../../lib/core/types'
import type { OperationSubset } from '../../../lib/operations'

// The "Lands in" line under a copy's or a move's destination. rclone's own copy puts a folder's
// contents into the destination. These pages put each selected folder and file inside the
// destination under its own name (core/operations, buildTransfer), so the line shows where they
// will be. The core works it out the way Start would.

/**
 * The line for the landings of a copy or a move into `destination`, or undefined when there is
 * nothing to say. A folder's name ends with a slash. Several landings are listed by name, three
 * at most before "and N more". Each length of the list is a message of its own, so that a
 * language can join the names its own way.
 */
export function landingLine(
    landings: readonly Operations.Landing[] | undefined,
    destination: string
): string | undefined {
    if (!landings || landings.length === 0) return undefined
    if (landings.length === 1) {
        const [only] = landings
        const path = only.path
        if (only.contents) return t`Its contents land straight in ${path}`
        return only.folder
            ? t({ message: `Lands in ${path}`, comment: 'Where a copied folder will be.' })
            : t({ message: `Lands as ${path}`, comment: 'Where a copied file will be.' })
    }
    const place = destination.trim()
    const [first, second, third] = landings.map((l) => (l.folder ? `${l.name}/` : l.name))
    if (landings.length === 2) return t`Lands in ${place} as ${first} and ${second}`
    if (landings.length === 3) return t`Lands in ${place} as ${first}, ${second} and ${third}`
    const rest = landings.length - 3
    return plural(rest, {
        one: `Lands in ${place} as ${first}, ${second}, ${third} and # more`,
        other: `Lands in ${place} as ${first}, ${second}, ${third} and # more`,
    })
}

/**
 * The landings of a copy or a move, asked of the core 400 ms after the paths stop changing. The
 * last answer stays while a new one is on its way. It is undefined while the paths are missing,
 * and when the core would refuse the form (the page shows why when Start is pressed).
 */
export function useLandings(
    operation: OperationSubset<'copy' | 'move'>,
    sources: readonly string[] | undefined,
    destination: string | undefined,
    remotes: Operations.Groups['remotes']
): Operations.Landing[] | undefined {
    const paths = (sources ?? []).filter((s) => s.trim() !== '')
    const ready = paths.length > 0 && !!destination?.trim()
    const key = ready ? JSON.stringify({ sources: paths, destination, remotes }) : ''
    const [asked] = useDebounce(key, 400)
    const query = useQuery({
        // files.changed and remotes.changed mark it stale (lib/live.ts), because what is in the
        // destination decides where each source lands.
        queryKey: coreKey('transfers', 'Landings', { operation, asked }),
        queryFn: () => {
            const { sources, destination, remotes } = JSON.parse(asked) as {
                sources: string[]
                destination: string
                remotes: Operations.Groups['remotes']
            }
            return api.Landings(operation as Operations.Operation, {
                sources,
                destination,
                options: { remotes },
            })
        },
        enabled: asked !== '',
        retry: false,
        placeholderData: keepPreviousData,
    })
    if (!ready || query.isError) return undefined
    return query.data ?? undefined
}
