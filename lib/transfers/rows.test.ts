import { expect, test } from 'vitest'
import type { Bus } from '../core/types'
import { isLive, percent, phaseOf } from './rows'

const progress = (patch: Partial<Bus.TransferProgress>): Bus.TransferProgress => ({
    seq: 1,
    state: 'running',
    bytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: null,
    pct: 0,
    files: 0,
    totalFiles: 0,
    errors: 0,
    checks: 0,
    listed: 0,
    transferring: [],
    checking: [],
    transferred: [],
    ...patch,
})

test('a running transfer is transferring, checking or still getting going', () => {
    expect(phaseOf('running', undefined)).toBe('preparing')
    expect(phaseOf('running', progress({ listed: 40 }))).toBe('preparing')
    expect(phaseOf('running', progress({ checking: [{ name: 'a' }] }))).toBe('checking')
    const file = { name: 'a', size: 10, bytes: 0, pct: 0, speed: 0 }
    expect(phaseOf('running', progress({ transferring: [file], checking: [{ name: 'b' }] }))).toBe(
        'transferring'
    )
    expect(phaseOf('running', progress({ bytes: 5 }))).toBe('transferring')
})

test('only a running transfer has a phase and live numbers', () => {
    expect(isLive('running')).toBe(true)
    for (const state of ['queued', 'completed', 'failed', 'stopped', 'interrupted']) {
        expect(isLive(state)).toBe(false)
        expect(phaseOf(state, progress({ bytes: 5 }))).toBeNull()
    }
})

test('a percentage is rounded down, so 100 means that every byte moved', () => {
    expect(percent(995, 1000)).toBe(99)
    expect(percent(29, 100)).toBe(29)
    expect(percent(2, 3)).toBe(66)
    expect(percent(1000, 1000)).toBe(100)
    expect(percent(1200, 1000)).toBe(100)
    expect(percent(0, 1000)).toBe(0)
    expect(percent(5, 0)).toBe(0)
})
