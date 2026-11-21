import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coreKey } from './core/query'
import {
    followCoreEvents,
    followShellEvents,
    invalidate,
    invalidates,
    MAX_WAIT,
    onLive,
    QUIET,
    shellKeys,
} from './live'

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

function emit(name: string, data?: unknown) {
    for (const callback of [...(fake.listeners.get(name) ?? [])]) callback({ name, data })
}

/** Returns a client with one cached query for each method, given as `<domain>/<Method>`. */
function cached(...methods: string[]) {
    const queryClient = new QueryClient()
    for (const m of methods) {
        const [service, method] = m.split('/')
        queryClient.setQueryData(coreKey(service, method), {})
    }
    return queryClient
}

/** Lists the methods whose queries are stale, as `<domain>/<Method>`. */
function stale(queryClient: QueryClient) {
    return queryClient
        .getQueryCache()
        .findAll({ predicate: (q) => q.state.isInvalidated })
        .map((q) => `${q.queryKey[1]}/${q.queryKey[2]}`)
        .sort()
}

/** The core's bound APIs (core/<domain>/api.ts), as `<domain>/<Method>`. */
function boundMethods(): string[] {
    // The folder name is the service name, the same name that lib/core/api.ts exports.
    const bound = import.meta.glob<Record<string, unknown>>(
        './shell/bindings/github.com/rclone/rclone-ui/core/*/api.ts',
        { eager: true }
    )
    const methods: string[] = []
    for (const [path, module] of Object.entries(bound)) {
        const service = path.split('/').at(-2) as string
        for (const method of Object.keys(module)) methods.push(`${service}/${method}`)
    }
    return methods.sort()
}

describe('invalidates', () => {
    it('every target names a bound API or one of its methods', () => {
        const known = new Set<string>()
        for (const method of boundMethods()) {
            known.add(method)
            known.add(method.split('/')[0])
        }
        expect(known.has('remotes/Health')).toBe(true)
        for (const [event, targets] of Object.entries(invalidates)) {
            for (const target of targets ?? []) {
                expect(known.has(target), `${event}: ${target}`).toBe(true)
            }
        }
    })

    // A target covers its domain's queries, or one method's, whatever their input.
    it('each event makes stale exactly the methods that its targets name', () => {
        const methods = boundMethods()
        for (const [event, targets = []] of Object.entries(invalidates)) {
            const queryClient = new QueryClient()
            for (const m of methods) {
                const [service, method] = m.split('/')
                queryClient.setQueryData(coreKey(service, method), {})
                queryClient.setQueryData(coreKey(service, method, { id: 'x' }), {})
            }
            invalidate(queryClient, event as keyof typeof invalidates)
            const expected = methods
                .filter((m) => targets.includes(m) || targets.includes(m.split('/')[0]))
                .flatMap((m) => [m, m])
            expect(stale(queryClient), event).toEqual(expected)
        }
    })

    it('the landings of a copy follow the files and the remotes', () => {
        for (const event of ['files.changed', 'remotes.changed'] as const) {
            const queryClient = new QueryClient()
            queryClient.setQueryData(coreKey('transfers', 'Landings', { operation: 'copy' }), [])
            queryClient.setQueryData(coreKey('transfers', 'ListActive'), [])
            invalidate(queryClient, event)
            expect(stale(queryClient), event).toEqual(['transfers/Landings'])
        }
    })

    it('remotes.health makes only Health stale', () => {
        const queryClient = cached('remotes/Health', 'remotes/List', 'remotes/CurrentSession')
        invalidate(queryClient, 'remotes.health')
        expect(stale(queryClient)).toEqual(['remotes/Health'])
    })

    it('settings.changed leaves the catalog alone', () => {
        const queryClient = cached('settings/Get', 'catalog/Get', 'catalog/Values')
        invalidate(queryClient, 'settings.changed')
        expect(stale(queryClient)).toEqual(['settings/Get'])
    })

    it('an event nothing maps changes nothing', () => {
        const queryClient = cached('remotes/List', 'app/Info')
        invalidate(queryClient, 'transfers.progress')
        expect(stale(queryClient)).toEqual([])
    })
})

describe('followCoreEvents', () => {
    let stop: () => void = () => undefined
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => {
        stop()
        vi.useRealTimers()
    })

    it('makes stale what an event changed, and hands its payload to who listens', () => {
        const queryClient = cached('transfers/ListActive', 'app/Info')
        stop = followCoreEvents(queryClient)
        const heard: unknown[] = []
        const off = onLive('transfers.changed', (d) => heard.push(d.id))
        emit('transfers.changed', {
            id: 't1',
            state: 'running',
            operation: 'copy',
            sources: ['a:x'],
        })
        off()
        expect(heard).toEqual(['t1'])
        expect(stale(queryClient)).toEqual([])
        vi.advanceTimersByTime(QUIET)
        expect(stale(queryClient)).toEqual(['transfers/ListActive'])
    })

    it('refetches everything after missed events', () => {
        const queryClient = cached('remotes/List', 'app/Info')
        stop = followCoreEvents(queryClient)
        emit('core.resync')
        vi.advanceTimersByTime(QUIET)
        expect(stale(queryClient)).toEqual(['app/Info', 'remotes/List'])
    })

    it('stops listening when stopped', () => {
        const queryClient = cached('remotes/List')
        stop = followCoreEvents(queryClient)
        stop()
        emit('remotes.changed', {})
        vi.advanceTimersByTime(MAX_WAIT)
        expect(stale(queryClient)).toEqual([])
    })

    it('waits until the events stop', () => {
        const queryClient = cached('remotes/List', 'templates/List')
        stop = followCoreEvents(queryClient)
        emit('remotes.changed', {})
        vi.advanceTimersByTime(QUIET - 50)
        emit('templates.changed')
        vi.advanceTimersByTime(QUIET - 50)
        expect(stale(queryClient)).toEqual([])
        vi.advanceTimersByTime(50)
        expect(stale(queryClient)).toEqual(['remotes/List', 'templates/List'])
    })

    it('waits at most a second after the first event', () => {
        const queryClient = cached('browse/List')
        const spy = vi.spyOn(queryClient, 'invalidateQueries')
        stop = followCoreEvents(queryClient)
        for (let t = 0; t < MAX_WAIT; t += 100) {
            emit('files.changed', {})
            vi.advanceTimersByTime(100)
        }
        expect(stale(queryClient)).toEqual(['browse/List'])
        expect(spy).toHaveBeenCalledTimes(1)
        // A stop stops a burst that is still going on.
        emit('files.changed', {})
        stop()
        vi.advanceTimersByTime(MAX_WAIT)
        expect(spy).toHaveBeenCalledTimes(1)
    })
})

describe('followShellEvents', () => {
    it('sets the shell’s queries when another window changes them', () => {
        const queryClient = new QueryClient()
        queryClient.setQueryData(shellKeys.autostart, false)
        const stop = followShellEvents(queryClient)
        emit('autostart:changed', true)
        expect(queryClient.getQueryData(shellKeys.autostart)).toBe(true)
        const state = { supported: true, enabled: true, command: 'rclone' }
        emit('pathlink:changed', state)
        expect(queryClient.getQueryData(shellKeys.pathLink)).toEqual(state)
        stop()
        emit('autostart:changed', false)
        expect(queryClient.getQueryData(shellKeys.autostart)).toBe(true)
    })

    it('keeps the agents’ command, which their event leaves out', () => {
        const queryClient = new QueryClient()
        const stop = followShellEvents(queryClient)
        // Before the first read there is nothing to update.
        emit('agents:changed', { running: true, url: 'http://127.0.0.1:5590/mcp', error: '' })
        expect(queryClient.getQueryData(shellKeys.agents)).toBeUndefined()
        queryClient.setQueryData(shellKeys.agents, {
            running: false,
            url: '',
            error: '',
            command: '/Applications/Rclone UI.app/Contents/MacOS/rclone-ui',
        })
        emit('agents:changed', { running: true, url: 'http://127.0.0.1:5590/mcp', error: '' })
        expect(queryClient.getQueryData(shellKeys.agents)).toEqual({
            running: true,
            url: 'http://127.0.0.1:5590/mcp',
            error: '',
            command: '/Applications/Rclone UI.app/Contents/MacOS/rclone-ui',
        })
        stop()
    })
})
