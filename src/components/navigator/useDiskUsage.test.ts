import { CancellablePromise } from '@wailsio/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coreFailure } from '../../../lib/errors.testing'
import { DiskUsage } from './useDiskUsage'

// Fakes of the Wails events and the bound calls. A scan's call stays open until the test ends
// it, and the test sends its progress.
const fake = vi.hoisted(() => ({
    listeners: new Set<(ev: { name: string; data: unknown }) => void>(),
    scans: [] as {
        request: string
        from: string
        resolve: () => void
        reject: (error: unknown) => void
        cancelled: boolean
    }[],
    roots: {} as Record<string, string>,
    forgotten: [] as [string, boolean][],
    stopped: [] as string[],
}))

vi.mock('@wailsio/runtime', async (actual) => ({
    ...(await actual<typeof import('@wailsio/runtime')>()),
    Events: {
        On: (name: string, callback: (ev: { name: string; data: unknown }) => void) => {
            const listener = (ev: { name: string; data: unknown }) => {
                if (ev.name === name) callback(ev)
            }
            fake.listeners.add(listener)
            return () => fake.listeners.delete(listener)
        },
    },
}))

vi.mock('../../../lib/core/api', () => ({
    browse: {
        Usage: (request: string, from: string) => {
            const scan = {
                request,
                from,
                resolve: () => undefined,
                reject: (_error: unknown) => undefined,
                cancelled: false,
            } as (typeof fake.scans)[number]
            fake.scans.push(scan)
            return new CancellablePromise<void>(
                (resolve, reject) => {
                    scan.resolve = resolve
                    scan.reject = reject
                },
                () => {
                    scan.cancelled = true
                }
            )
        },
        UsageRoot: async (from: string) => fake.roots[from] ?? from,
        UsageForget: async (_request: string, rel: string, isDir: boolean) => {
            fake.forgotten.push([rel, isDir])
        },
        UsageStop: async (request: string) => {
            fake.stopped.push(request)
        },
    },
}))

/** Sends a scan's progress the way the core does. */
function progress(request: string, state: string, root = 'gdrive:', bytes = 0) {
    const data = {
        request,
        root,
        local: false,
        state,
        count: { bytes, files: 0, folders: 0, unknown: 0, unread: 0 },
    }
    for (const listener of [...fake.listeners]) listener({ name: 'browse:usage', data })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
    fake.listeners.clear()
    fake.scans.length = 0
    fake.roots = {}
    fake.forgotten.length = 0
    fake.stopped.length = 0
})

describe('the scan that the page holds', () => {
    it('follows its progress until it ends', async () => {
        const usage = new DiskUsage()
        const detach = usage.attach()
        await usage.open('gdrive:photos')
        const { request } = fake.scans[0]
        expect(usage.snapshot()).toMatchObject({ phase: 'opening', from: 'gdrive:photos', request })
        progress(request, 'scanning', 'gdrive:', 10)
        expect(usage.snapshot()).toMatchObject({
            phase: 'scanning',
            progress: { count: { bytes: 10 } },
        })
        progress('another request', 'done')
        expect(usage.snapshot().phase).toBe('scanning')
        progress(request, 'done', 'gdrive:', 20)
        expect(usage.snapshot()).toMatchObject({ phase: 'ended', progress: { state: 'done' } })
        detach()
        expect(fake.scans[0].cancelled).toBe(true)
    })

    it('shows the same scan again for a folder on the same remote, and scans another one anew', async () => {
        const usage = new DiskUsage()
        const detach = usage.attach()
        await usage.open('gdrive:photos')
        progress(fake.scans[0].request, 'done', 'gdrive:')
        fake.roots['gdrive:music'] = 'gdrive:'
        await usage.open('gdrive:music')
        expect(fake.scans).toHaveLength(1)

        fake.roots['/Users/me'] = '/'
        await usage.open('/Users/me')
        expect(fake.scans).toHaveLength(2)
        expect(fake.scans[0].cancelled).toBe(true)
        expect(usage.snapshot()).toMatchObject({ phase: 'opening', from: '/Users/me' })
        detach()
    })

    it('reports why nothing could be scanned, and scans again from the same folder', async () => {
        const usage = new DiskUsage()
        const detach = usage.attach()
        await usage.open('gdrive:')
        fake.scans[0].reject(coreFailure('reconnect', 'Sign in again', { remote: 'gdrive' }))
        await settle()
        expect(usage.snapshot()).toMatchObject({
            phase: 'failed',
            error: 'Sign in again',
            reconnect: 'gdrive',
        })
        usage.rescan()
        expect(fake.scans).toHaveLength(2)
        expect(fake.scans[1].from).toBe('gdrive:')
        // The first call's end no longer matters.
        expect(usage.snapshot().phase).toBe('opening')
        detach()
    })

    it('ignores the end of a call that it replaced', async () => {
        const usage = new DiskUsage()
        const detach = usage.attach()
        await usage.open('a:')
        await usage.open('b:')
        expect(fake.scans[0].cancelled).toBe(true)
        fake.scans[0].resolve()
        await settle()
        expect(usage.snapshot()).toMatchObject({ phase: 'opening', from: 'b:' })
        detach()
    })

    it('knows when the core let go of the scan', async () => {
        const usage = new DiskUsage()
        const detach = usage.attach()
        await usage.open('gdrive:')
        progress(fake.scans[0].request, 'done')
        fake.scans[0].resolve()
        await settle()
        expect(usage.snapshot().phase).toBe('gone')
        // A gone scan isn't shown again: opening scans anew.
        await usage.open('gdrive:')
        expect(fake.scans).toHaveLength(2)
        detach()
    })

    it('stops, and takes a deleted entry out so the folder is read again', async () => {
        const usage = new DiskUsage()
        const detach = usage.attach()
        await usage.open('gdrive:')
        const { request } = fake.scans[0]
        usage.stop()
        expect(fake.stopped).toEqual([request])
        await usage.forget('photos/2024', true)
        expect(fake.forgotten).toEqual([['photos/2024', true]])
        expect(usage.snapshot().version).toBe(1)
        detach()
    })
})
