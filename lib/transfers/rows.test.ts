import { expect, test } from 'vitest'
import type { Bus } from '../core/types'
import { isLive, phaseOf } from './rows'

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
    // Some bytes have moved and nothing is in flight right now, so it is still transferring.
    expect(phaseOf('running', progress({ bytes: 5 }))).toBe('transferring')
})

test('only a running transfer has a phase and live numbers', () => {
    expect(isLive('running')).toBe(true)
    for (const state of ['queued', 'completed', 'failed', 'stopped', 'interrupted']) {
        expect(isLive(state)).toBe(false)
        expect(phaseOf(state, progress({ bytes: 5 }))).toBeNull()
    }
})
