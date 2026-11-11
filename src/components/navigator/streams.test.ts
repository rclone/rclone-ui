import { CancellablePromise } from '@wailsio/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coreFailure } from '../../../lib/errors.testing'
import { follow, runList, runSizes } from './streams'

// Fakes of the Wails events and the bound calls. A call stays open until the test ends it, and
// the test sends its events.
const fake = vi.hoisted(() => ({
    listeners: new Map<string, Set<(ev: { name: string; data: unknown }) => void>>(),
    calls: [] as {
        request: string
        args: unknown[]
        resolve: () => void
        reject: (error: unknown) => void
        cancelled: boolean
    }[],
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

/** A bound call that stays open. The test resolves or rejects it, or checks that it was cancelled. */
function held(request: string, ...args: unknown[]) {
    const call = {
        request,
        args,
        resolve: () => undefined,
        reject: (_error: unknown) => undefined,
        cancelled: false,
    } as (typeof fake.calls)[number]
    fake.calls.push(call)
    return new CancellablePromise<void>(
        (resolve, reject) => {
            call.resolve = resolve
            call.reject = reject
        },
        () => {
            call.cancelled = true
        }
    )
}

vi.mock('../../../lib/core/api', () => ({
    browse: {
        List: (request: string, path: string, fresh: boolean) => held(request, path, fresh),
        Sizes: (request: string, paths: string[]) => held(request, paths),
    },
}))

/** Sends an event the way the core does. */
function emit(name: string, data: unknown) {
    for (const callback of [...(fake.listeners.get(name) ?? [])]) callback({ name, data })
}

const listening = (name: string) => fake.listeners.get(name)?.size ?? 0

const row = (path: string) => ({
    path,
    name: path,
    size: 1,
    modTime: '',
    isDir: false,
    id: '',
    tier: '',
    isBucket: false,
})

/** A sink that records everything it receives. */
function recorder<T>() {
    const got = { items: [] as T[], progress: [] as number[], ends: [] as unknown[] }
    return {
        got,
        sink: {
            add: (items: T[]) => got.items.push(...items),
            progress: (n: number) => got.progress.push(n),
            end: (info: unknown) => got.ends.push(info),
        },
    }
}

afterEach(() => {
    fake.calls.length = 0
    fake.listeners.clear()
})

describe('follow', () => {
    it("hands over its own request's pieces in order, and ends with the last", async () => {
        const pieces: unknown[] = []
        const done = follow(
            'browse:rows',
            (request) => held(request),
            (p) => pieces.push(p)
        )
        const { request } = fake.calls[0]
        emit('browse:rows', { request, entries: [row('a')] })
        emit('browse:rows', { request: 'another', entries: [row('x')] })
        emit('browse:rows', { request, entries: [row('b')] })
        emit('browse:rows', { request, entries: [], done: true })
        await done
        expect(
            pieces.map((p) => (p as { entries: { path: string }[] }).entries.map((r) => r.path))
        ).toEqual([['a'], ['b'], []])
        expect(listening('browse:rows')).toBe(0)
    })

    it('waits for the last piece even when the call answered first', async () => {
        let ended = false
        const done = follow(
            'browse:rows',
            (request) => held(request),
            () => undefined
        ).then(() => {
            ended = true
        })
        const call = fake.calls[0]
        call.resolve()
        await Promise.resolve()
        expect(ended).toBe(false)
        emit('browse:rows', { request: call.request, entries: [], done: true })
        await done
        expect(ended).toBe(true)
    })

    it("rejects with the call's error and stops listening", async () => {
        const done = follow(
            'browse:rows',
            (request) => held(request),
            () => undefined
        )
        fake.calls[0].reject(coreFailure('not_found', 'directory not found'))
        await expect(done).rejects.toThrow('directory not found')
        expect(listening('browse:rows')).toBe(0)
    })

    it('cancels the call when aborted, and hears nothing after', async () => {
        const abort = new AbortController()
        const pieces: unknown[] = []
        const done = follow(
            'browse:rows',
            (request) => held(request),
            (p) => pieces.push(p),
            abort.signal
        )
        const call = fake.calls[0]
        abort.abort()
        await expect(done).rejects.toBeDefined()
        expect(call.cancelled).toBe(true)
        emit('browse:rows', { request: call.request, entries: [row('late')] })
        expect(pieces).toEqual([])
        expect(listening('browse:rows')).toBe(0)
    })
})

describe('the reads', () => {
    it('a listing hands over its rows, then when it was listed and whether it was capped', async () => {
        const { got, sink } = recorder()
        const done = runList({ path: 'gdrive:photos' }, true, new AbortController().signal, sink)
        const { request, args } = fake.calls[0]
        expect(args).toEqual(['gdrive:photos', true])
        emit('browse:rows', { request, entries: [row('a'), row('b')] })
        emit('browse:rows', { request, entries: [], done: true, fetchedAt: 100, capped: true })
        await done
        expect(got.items).toHaveLength(2)
        expect(got.ends).toEqual([{ fetchedAt: 100, capped: true }])
    })

    it('folder sizes hand over each folder as it is counted, and not the last piece', async () => {
        const { got, sink } = recorder()
        const done = runSizes({ paths: ['/a', '/b'] }, false, new AbortController().signal, sink)
        const { request, args } = fake.calls[0]
        expect(args).toEqual([['/a', '/b']])
        emit('browse:size', { request, path: '/a', files: 1, bytes: 5 })
        emit('browse:size', { request, path: '/b', files: 2, bytes: 6, partial: true })
        emit('browse:size', { request, files: 0, bytes: 0, done: true })
        await done
        expect(got.items).toEqual([
            { request, path: '/a', files: 1, bytes: 5 },
            { request, path: '/b', files: 2, bytes: 6, partial: true },
        ])
        expect(got.progress).toEqual([1, 2])
        expect(got.ends).toEqual([{}])
    })
})
