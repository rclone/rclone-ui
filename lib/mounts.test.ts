import { expect, test, vi } from 'vitest'
import { cannotMount, followStart, MountFailedError, uploadsPollInterval } from './mounts'

const fake = vi.hoisted(() => ({
    listeners: new Map<string, Set<(ev: { name: string; data: unknown }) => void>>(),
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
vi.mock('./shell', () => ({ ask: vi.fn(), openUrl: vi.fn(), platform: () => 'darwin' }))

function emit(name: string, data?: unknown) {
    for (const callback of [...(fake.listeners.get(name) ?? [])]) callback({ name, data })
}

function listening() {
    let n = 0
    for (const set of fake.listeners.values()) n += set.size
    return n
}

/** Lets the promises queued so far run. */
const settled = () => new Promise((r) => setTimeout(r, 0))

/** Follows a start that resolves once `answer` is called. The test sets the row that is read. */
function harness() {
    let answer: () => void = () => undefined
    const answered = new Promise<{ id: string }>((resolve) => {
        answer = () => resolve({ id: 'm1' })
    })
    const state = { row: undefined as { running: boolean } | undefined, reads: 0 }
    const followed = followStart(
        'mounts.changed',
        () => answered,
        async (id) => {
            expect(id).toBe('m1')
            state.reads++
            return state.row
        },
        (message, cannot) => new MountFailedError(message, cannot)
    )
    return { answer, state, followed }
}

test('a resync finds the mount running: the start resolves', async () => {
    const h = harness()
    h.answer()
    await settled()
    h.state.row = { running: true }
    emit('core.resync')
    await expect(h.followed).resolves.toEqual({ id: 'm1' })
    expect(listening()).toBe(0)
})

test('a resync finds it gone: the start rejects', async () => {
    const h = harness()
    h.answer()
    await settled()
    emit('core.resync')
    await expect(h.followed).rejects.toThrow('It stopped before it ran.')
})

test('a resync finds it still starting: the events settle it', async () => {
    const h = harness()
    h.answer()
    await settled()
    h.state.row = { running: false }
    emit('core.resync')
    await settled()
    expect(h.state.reads).toBe(1)
    emit('mounts.changed', { id: 'm1', state: 'failed', error: 'no fuse' })
    await expect(h.followed).rejects.toThrow('no fuse')
})

test('a resync while the start is answering: read once it has', async () => {
    const h = harness()
    emit('core.resync')
    await settled()
    expect(h.state.reads).toBe(0)
    h.state.row = { running: true }
    h.answer()
    await expect(h.followed).resolves.toEqual({ id: 'm1' })
    expect(h.state.reads).toBe(1)
})

test('a running event before the start answers: it resolves once it has', async () => {
    const h = harness()
    emit('mounts.changed', { id: 'm1', state: 'running', mountPoint: '/mnt/m1' })
    h.answer()
    await expect(h.followed).resolves.toEqual({ id: 'm1' })
    expect(h.state.reads).toBe(0)
    expect(listening()).toBe(0)
})

test('a failed event says whether this computer cannot mount', async () => {
    const h = harness()
    h.answer()
    await settled()
    emit('mounts.changed', { id: 'm1', state: 'failed', error: 'no fuse', cannotMount: true })
    const error = await h.followed.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MountFailedError)
    expect((error as MountFailedError).cannotMount).toBe(true)
    expect(cannotMount(error)).toBe(true)
})

test('a failed event before the start answers keeps the reason', async () => {
    const h = harness()
    emit('mounts.changed', { id: 'm1', state: 'failed', error: 'no fuse', cannotMount: true })
    h.answer()
    const error = await h.followed.catch((e: unknown) => e)
    expect(cannotMount(error)).toBe(true)
})

test('a mount that failed for another reason shows its error', () => {
    expect(cannotMount(new MountFailedError('the remote said no'))).toBe(false)
    // A rejection from the core, before the mount started, may be the can't-mount one.
    expect(cannotMount(new Error('This computer cannot mount'))).toBe(true)
})

test('the mounts are read again only while uploads are pending', () => {
    expect(uploadsPollInterval(undefined)).toBe(false)
    expect(uploadsPollInterval([{ uploadsPending: 0 }])).toBe(false)
    expect(uploadsPollInterval([{ uploadsPending: 0 }, { uploadsPending: 4 }])).toBeGreaterThan(0)
})
