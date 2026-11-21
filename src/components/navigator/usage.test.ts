import { describe, expect, it } from 'vitest'
import type { Browse } from '../../../lib/core/types'
import {
    barLength,
    crumbsOf,
    formatShare,
    parentRel,
    REST_KEY,
    rowsToAsk,
    rowsToDraw,
    shareOf,
    type UsageItem,
    usageItems,
} from './usage'

function row(name: string, bytes: number, files = 1, isDir = true): Browse.UsageRow {
    return {
        name,
        rel: `a/${name}`,
        path: `mem:a/${name}`,
        isDir,
        bytes,
        files,
        folders: 0,
        unknown: 0,
    }
}

function level(
    rows: Browse.UsageRow[],
    rest = { files: 0, bytes: 0, unknown: 0 }
): Browse.UsageLevel {
    return {
        rel: 'a',
        total: row(
            'a',
            rows.reduce((n, r) => n + r.bytes, rest.bytes)
        ),
        rows,
        more: 0,
        rest,
    }
}

describe('the lines of a folder', () => {
    it('keeps each entry under the same key as its size changes, so its row glides', () => {
        const before = usageItems(level([row('photos', 10), row('music', 5)]), 'size')
        const after = usageItems(level([row('music', 50), row('photos', 10)]), 'size')
        expect(before.map((i) => i.key)).toEqual(['d:photos', 'd:music'])
        expect(after.map((i) => i.key)).toEqual(['d:music', 'd:photos'])
    })

    it('tells a file from a folder of the same name', () => {
        const items = usageItems(level([row('logs', 10), row('logs', 3, 1, false)]), 'size')
        expect(items.map((i) => i.key)).toEqual(['d:logs', 'f:logs'])
    })

    it('places the smaller files by their size, or last when sorted by name', () => {
        const rest = { files: 40, bytes: 7, unknown: 0 }
        const rows = [row('big', 10), row('small', 3, 1, false)]
        const bySize = usageItems(level(rows, rest), 'size')
        expect(bySize.map((i) => i.key)).toEqual(['d:big', REST_KEY, 'f:small'])
        expect(bySize[1]).toMatchObject({ rest: true, files: 40, bytes: 7, isDir: false })
        expect(usageItems(level(rows, rest), 'files').map((i) => i.key)).toEqual([
            REST_KEY,
            'd:big',
            'f:small',
        ])
        expect(usageItems(level(rows, rest), 'name').map((i) => i.key)).toEqual([
            'd:big',
            'f:small',
            REST_KEY,
        ])
        expect(usageItems(level(rows), 'size').map((i) => i.key)).toEqual(['d:big', 'f:small'])
    })
})

describe('bars and shares', () => {
    it('measures a bar against the largest entry, and a share against the folder', () => {
        expect(barLength(5, 10)).toBe(0.5)
        expect(barLength(10, 10)).toBe(1)
        expect(barLength(3, 0)).toBe(0)
        expect(shareOf(25, 100)).toBe(0.25)
        expect(shareOf(1, 0)).toBe(0)
    })

    it('writes a sliver as less than 1% rather than 0%', () => {
        expect(formatShare(0.42)).toBe('42%')
        expect(formatShare(0.004)).toBe('<1%')
        expect(formatShare(0)).toBe('0%')
    })
})

describe('the rows to read and draw', () => {
    it('asks for the rows down to the view, with a margin, in steps', () => {
        expect(rowsToAsk(0, 600, 40)).toBe(200)
        expect(rowsToAsk(8000, 600, 40)).toBe(400)
        expect(rowsToAsk(8040, 600, 40)).toBe(400)
    })

    it('draws the rows in view, and those leaving it, so they glide away', () => {
        const items = ['a', 'b', 'c', 'd'].map((key) => ({ key }) as UsageItem)
        // d was at rank 1, in view, and dropped to rank 3, out of view.
        const was = new Map([
            ['a', 0],
            ['d', 1],
            ['b', 2],
        ])
        const drawn = rowsToDraw(items, was, 0, 1)
        expect(drawn.map((d) => [d.item.key, d.rank])).toEqual([
            ['a', 0],
            ['b', 1],
            ['d', 3],
        ])
    })
})

describe('the way up', () => {
    it('lists each folder from the root down', () => {
        expect(crumbsOf('')).toEqual([])
        expect(crumbsOf('a/b')).toEqual([
            { name: 'a', rel: 'a' },
            { name: 'b', rel: 'a/b' },
        ])
        expect(parentRel('a/b')).toBe('a')
        expect(parentRel('a')).toBe('')
    })
})
