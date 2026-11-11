// The rows of the Compare drawer (`CompareDrawer`). The core's pairs are grouped by bucket into
// one flat list, which the drawer virtualizes because a compare can hold up to 20 000 names.

import { t } from '@lingui/core/macro'
import type { Browse } from '../../../lib/core/types'
import type { Entry } from './types'

export type CompareClass = Exclude<`${Browse.Class}`, ''>

export type CompareEntry = Entry

// One row across the two columns. In the "only on" buckets, exactly one side is present.
export type ComparePair = { name: string; left?: CompareEntry; right?: CompareEntry }

export const BUCKETS = [
    { key: 'onlyLeft', title: t`Only on left` },
    { key: 'onlyRight', title: t`Only on right` },
    // On both sides, but hashes are missing or differ.
    {
        key: 'sameByName',
        title: t({
            message: 'Same by name',
            comment: 'Files on both sides with the same name, whose content was not proved equal.',
        }),
    },
    // On both sides, and a hash type they share matches.
    {
        key: 'sameByHash',
        title: t({
            message: 'Same by hash',
            comment: 'Files on both sides whose checksums (hashes) match.',
        }),
    },
] as const satisfies readonly { key: CompareClass; title: string }[]

export type CompareResult = Record<CompareClass, ComparePair[]>

function entryOf(name: string, side: Browse.Side | null | undefined): CompareEntry | undefined {
    if (!side) return undefined
    return {
        key: name,
        name,
        isDir: side.isDir,
        // rclone reports -1 when a backend doesn't know the size.
        size: side.size >= 0 ? side.size : undefined,
        modTime: side.modTime,
        fullPath: name,
    }
}

// The core lists both folders with hashes and sorts every name into its bucket (the `compare` job
// in jobs.ts). Folders come first, then names in order, and dot-names are left out.
export function bucketed(pairs: readonly Browse.Pair[]): CompareResult {
    const result: CompareResult = { onlyLeft: [], onlyRight: [], sameByName: [], sameByHash: [] }
    for (const pair of pairs) {
        result[pair.class as CompareClass]?.push({
            name: pair.name,
            left: entryOf(pair.name, pair.left),
            right: entryOf(pair.name, pair.right),
        })
    }
    return result
}

/**
 * One line of the drawer. It is either a bucket's header (`first` marks the topmost one, which
 * has no gap above it) or a pair in a bucket (`first` and `last` mark the rows that round the
 * corners of its box).
 */
export type CompareLine =
    | { kind: 'header'; key: string; title: string; count: number; first: boolean }
    | { kind: 'pair'; key: string; pair: ComparePair; first: boolean; last: boolean }

/** The buckets that hold names, each as a header and its pairs. Empty buckets are skipped. */
export function compareLines(result: CompareResult): CompareLine[] {
    const lines: CompareLine[] = []
    for (const bucket of BUCKETS) {
        const pairs = result[bucket.key]
        if (pairs.length === 0) continue
        lines.push({
            kind: 'header',
            key: bucket.key,
            title: bucket.title,
            count: pairs.length,
            first: lines.length === 0,
        })
        for (let i = 0; i < pairs.length; i++) {
            lines.push({
                kind: 'pair',
                key: `${bucket.key}/${pairs[i].name}`,
                pair: pairs[i],
                first: i === 0,
                last: i === pairs.length - 1,
            })
        }
    }
    return lines
}
