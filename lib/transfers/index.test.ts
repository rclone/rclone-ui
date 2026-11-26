import { describe, expect, it } from 'vitest'
import type { Bus } from '../core/types'
import { keepLeft, type LiveNumbers } from './index'

const numbers = (bytes: number): Bus.TransferProgress => ({
    seq: 1,
    state: 'running',
    bytes,
    totalBytes: 100,
    speed: 0,
    eta: null,
    pct: bytes,
    files: 0,
    totalFiles: 1,
    errors: 0,
    checks: 0,
    listed: 0,
    transferring: [],
    checking: [],
    transferred: [],
})

describe('keepLeft', () => {
    it('keeps the last numbers of a transfer that left, until it comes back', () => {
        const held = new Map<string, Bus.TransferProgress>()
        const first: LiveNumbers = { a: numbers(90), b: numbers(10) }
        const second: LiveNumbers = { b: numbers(20) }
        expect(keepLeft(held, {}, first)).toBe(first)
        expect(keepLeft(held, first, second)).toEqual({ a: numbers(90), b: numbers(20) })
        expect(keepLeft(held, second, { b: numbers(30) })).toEqual({
            a: numbers(90),
            b: numbers(30),
        })
        expect(keepLeft(held, { b: numbers(30) }, { a: numbers(95) })).toEqual({
            a: numbers(95),
            b: numbers(30),
        })
        expect([...held.keys()]).toEqual(['b'])
    })

    it('keeps at most `max` transfers, and drops the oldest first', () => {
        const held = new Map<string, Bus.TransferProgress>()
        keepLeft(held, { a: numbers(1) }, {}, 2)
        keepLeft(held, { b: numbers(2) }, {}, 2)
        const live = keepLeft(held, { c: numbers(3) }, {}, 2)
        expect(Object.keys(live).sort()).toEqual(['b', 'c'])
    })
})
