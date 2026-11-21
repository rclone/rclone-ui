import { expect, test, vi } from 'vitest'
import { coreFailure } from '../../../lib/errors.testing'
import { ELSEWHERE, onTransferEnd } from './fsActions'

// Fakes of the Wails events and of the transfers that the core knows about.
const fake = vi.hoisted(() => ({
    listeners: new Map<string, Set<(ev: { name: string; data: unknown }) => void>>(),
    recorded: new Map<string, string>(),
}))

vi.mock('@wailsio/runtime', async (actual) => ({
    ...(await actual<typeof import('@wailsio/runtime')>()),
    Events: {
        On: (name: string, callback: (ev: { name: string; data: unknown }) => void) => {
            const set = fake.listeners.get(name) ?? new Set()
            set.add(callback)
            fake.listeners.set(name, set)
            return () => set.delete(callback)
        },
    },
}))
vi.mock('../../../lib/core/api', () => ({
    files: {},
    browse: {},
    transfers: {
        Get: async (id: string) => {
            if (id === 'unreachable') throw coreFailure('unavailable', 'the core is away')
            const state = fake.recorded.get(id)
            if (!state) throw coreFailure('not_found', 'no transfer')
            return { transfer: { id, state } }
        },
    },
}))
vi.mock('./listing', () => ({ entryChanged: () => undefined }))

function emit(name: string, data?: unknown) {
    for (const callback of [...(fake.listeners.get(name) ?? [])]) callback({ name, data })
}

test('an end among the missed events comes from the transfer on resync', async () => {
    const heard: string[] = []
    onTransferEnd('t1', (state) => heard.push(`t1 ${state}`))
    onTransferEnd('t2', (state) => heard.push(`t2 ${state}`))
    onTransferEnd('unreachable', (state) => heard.push(`unreachable ${state}`))
    fake.recorded.set('t1', 'completed')
    fake.recorded.set('t2', 'running')
    emit('core.resync')
    await vi.waitFor(() => expect(heard).toEqual(['t1 completed']))
    // Still waiting: the running transfer, and the one the core didn't return.
    emit('transfers.changed', { id: 't2', state: 'failed' })
    emit('transfers.changed', { id: 'unreachable', state: 'stopped' })
    expect(heard).toEqual(['t1 completed', 't2 failed', 'unreachable stopped'])
    // Known end states are reported immediately.
    onTransferEnd('t1', (state) => heard.push(`again ${state}`))
    expect(heard.at(-1)).toBe('again completed')
})

test('a transfer the core does not have is no longer waited for after resync', async () => {
    const heard: string[] = []
    onTransferEnd('t3', (state) => heard.push(`t3 ${state}`))
    emit('core.resync')
    await vi.waitFor(() => expect(heard).toEqual([`t3 ${ELSEWHERE}`]))
    // ELSEWHERE isn't a real end, so it isn't remembered.
    onTransferEnd('t3', (state) => heard.push(`again ${state}`))
    expect(heard).toEqual([`t3 ${ELSEWHERE}`])
    emit('transfers.changed', { id: 't3', state: 'completed' })
    expect(heard).toEqual([`t3 ${ELSEWHERE}`, 'again completed'])
})
