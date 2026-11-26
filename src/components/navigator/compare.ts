import { t } from '@lingui/core/macro'
import type { Browse } from '../../../lib/core/types'
import type { Entry } from './types'

export type CompareClass = Exclude<`${Browse.Class}`, ''>

export type CompareEntry = Entry

export type ComparePair = { name: string; left?: CompareEntry; right?: CompareEntry }

export const BUCKETS = [
    { key: 'onlyLeft', title: t`Only on left` },
    { key: 'onlyRight', title: t`Only on right` },
    {
        key: 'sameByName',
        title: t({
            message: 'Same by name',
            comment: 'Files on both sides with the same name, whose content was not proved equal.',
        }),
    },
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
        size: side.size >= 0 ? side.size : undefined,
        modTime: side.modTime,
        fullPath: name,
    }
}

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

export type CompareLine =
    | { kind: 'header'; key: string; title: string; count: number; first: boolean }
    | { kind: 'pair'; key: string; pair: ComparePair; first: boolean; last: boolean }

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
