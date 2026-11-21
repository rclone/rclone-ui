import { describe, expect, it } from 'vitest'
import type { Browse } from '../../../lib/core/types'
import { bucketed, compareLines } from './compare'

const side = (size: number, isDir = false): Browse.Side => ({
    size,
    isDir,
    modTime: '2026-01-02T03:04:05Z',
})

const pair = (cls: string, name: string, sides: { left?: boolean; right?: boolean }) =>
    ({
        class: cls,
        name,
        left: sides.left ? side(5) : null,
        right: sides.right ? side(5) : null,
    }) as Browse.Pair

describe('bucketed', () => {
    it('sorts each pair into its class, with the sides it has', () => {
        const result = bucketed([
            pair('onlyLeft', 'a.txt', { left: true }),
            pair('sameByHash', 'b.txt', { left: true, right: true }),
            pair('unknown', 'c.txt', { left: true }),
        ])
        expect(result.onlyLeft).toHaveLength(1)
        expect(result.onlyLeft[0].left).toMatchObject({ name: 'a.txt', size: 5, isDir: false })
        expect(result.onlyLeft[0].right).toBeUndefined()
        expect(result.sameByHash[0]).toMatchObject({ name: 'b.txt', left: {}, right: {} })
        expect(result.onlyRight).toEqual([])
        expect(result.sameByName).toEqual([])
    })

    it('reads an unknown size (-1) as none', () => {
        const result = bucketed([{ ...pair('onlyRight', 'x', {}), right: side(-1) }])
        expect(result.onlyRight[0].right?.size).toBeUndefined()
    })
})

describe('compareLines', () => {
    it("lists each bucket that holds names as its header and pairs, in the drawer's order", () => {
        const lines = compareLines(
            bucketed([
                pair('sameByName', 'n1', { left: true, right: true }),
                pair('onlyLeft', 'l1', { left: true }),
                pair('onlyLeft', 'l2', { left: true }),
            ])
        )
        expect(lines.map((l) => (l.kind === 'header' ? `# ${l.title} ${l.count}` : l.key))).toEqual(
            ['# Only on left 2', 'onlyLeft/l1', 'onlyLeft/l2', '# Same by name 1', 'sameByName/n1']
        )
    })

    it("marks the first header, and each bucket's first and last pair", () => {
        const lines = compareLines(
            bucketed([
                pair('onlyLeft', 'l1', { left: true }),
                pair('onlyLeft', 'l2', { left: true }),
                pair('onlyRight', 'r1', { right: true }),
            ])
        )
        expect(lines.map((l) => [l.first, l.kind === 'pair' ? l.last : null])).toEqual([
            [true, null],
            [true, false],
            [false, true],
            [false, null],
            [true, true],
        ])
    })

    it('keeps a name found in two buckets apart', () => {
        const lines = compareLines(
            bucketed([
                pair('onlyLeft', 'same', { left: true }),
                pair('onlyRight', 'same', { right: true }),
            ])
        )
        const keys = lines.map((l) => l.key)
        expect(new Set(keys).size).toBe(keys.length)
    })

    it('has no lines for an empty compare', () => {
        expect(compareLines(bucketed([]))).toEqual([])
    })
})
