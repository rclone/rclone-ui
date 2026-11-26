import { plural, t } from '@lingui/core/macro'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounce } from 'use-debounce'
import { transfers as api } from '../../../lib/core/api'
import { coreKey } from '../../../lib/core/query'
import type { Operations } from '../../../lib/core/types'
import type { OperationSubset } from '../../../lib/operations'

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
