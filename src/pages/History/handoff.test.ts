import { describe, expect, it } from 'vitest'
import type * as Core from '../../../lib/core/types'
import { type Handoff, nextHandoff } from './handoff'

type Transfer = Core.Transfers.Transfer

const transfer = (id: string) => ({ id }) as Transfer

const start = (active: Transfer[]): Handoff => ({ active, leaving: [], exits: 0 })

describe('nextHandoff', () => {
    it('holds a transfer that left until the ended list has it', () => {
        const a = transfer('a')
        let seen = start([a])
        seen = nextHandoff(seen, [], [], 100, 200)
        expect(seen.leaving.map((l) => l.item.id)).toEqual(['a'])
        expect(seen.exits).toBe(1)
        expect(nextHandoff(seen, seen.active, [], 150, 300)).toBe(seen)
        expect(nextHandoff(seen, seen.active, [a], 150, 300).leaving).toEqual([])
    })

    it('releases a dropped transfer when the ended list answers a question sent after it left', () => {
        let seen = nextHandoff(start([transfer('a')]), [], [], 0, 200)
        seen = nextHandoff(seen, seen.active, [], 250, 400)
        expect(seen.leaving).toEqual([])
    })

    it('keeps a transfer that left while an older question was on its way', () => {
        const seen = nextHandoff(start([transfer('a')]), [], [], 0, 200)
        expect(nextHandoff(seen, seen.active, [], 150, 400)).toBe(seen)
    })

    it('counts the exits, not the transfers that left', () => {
        const [a, b, c] = ['a', 'b', 'c'].map(transfer)
        let seen = start([a, b, c])
        seen = nextHandoff(seen, [c], [], 0, 100)
        expect(seen.exits).toBe(1)
        seen = nextHandoff(seen, [c, transfer('d')], [], 0, 200)
        expect(seen.exits).toBe(1)
        seen = nextHandoff(seen, [], [], 0, 300)
        expect(seen.exits).toBe(2)
        expect(seen.leaving.map((l) => [l.item.id, l.leftAt])).toEqual([
            ['a', 100],
            ['b', 100],
            ['c', 300],
            ['d', 300],
        ])
    })
})
