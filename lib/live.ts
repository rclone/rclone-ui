import type { QueryClient } from '@tanstack/react-query'
import { Events } from '@wailsio/runtime'
import { useEffect } from 'react'
import { type AgentsInfo, agents, autostart, pathLink } from './shell'

export type CoreEvents = Events.CustomEvents

/**
 * The queries that each event makes stale. A target is either a domain, which covers every query
 * of its API, or `<domain>/<Method>`, which covers that one method. Either one is the start of
 * the queries' keys (coreKey). `lib/live.test.ts` checks each target against the bound APIs.
 */
export const invalidates: Partial<Record<keyof CoreEvents, string[]>> = {
    'transfers.changed': ['transfers'],
    'remotes.changed': ['remotes', 'browse', 'transfers/Landings'],
    'files.changed': ['browse', 'transfers/Landings'],
    'remotes.health': ['remotes/Health'],
    'remotes.session': ['remotes'],
    'mounts.changed': ['mounts', 'vfs'],
    'serves.changed': ['serves', 'vfs'],
    'templates.changed': ['templates'],
    'favorites.changed': ['favorites'],
    'notifications.changed': ['notifications'],
    'settings.changed': ['settings'],
    'prefs.changed': ['prefs'],
    'tunnel.changed': ['tunnel'],
    'watchers.changed': ['watchers'],
    'schedules.changed': ['schedules'],
    'automounts.changed': ['mounts'],
}

const everything: (keyof CoreEvents)[] = ['core.resync', 'config.changed']

export function invalidate(queryClient: QueryClient, name: keyof CoreEvents) {
    if (everything.includes(name)) {
        queryClient.invalidateQueries()
        return
    }
    const targets = invalidates[name]
    if (!targets) return
    const prefixes = targets.map((target) => ['core', ...target.split('/')])
    queryClient.invalidateQueries({
        predicate: (q) =>
            prefixes.some((prefix) => prefix.every((part, i) => q.queryKey[i] === part)),
    })
}

export const QUIET = 250
export const MAX_WAIT = 1000

/**
 * Marks queries stale as the core's events arrive, until the returned function is called. A burst
 * of events, such as a transfer that changes many files, is handled once: the queries are marked
 * stale 250 ms after the events stop, and at most 1 s after the first one.
 */
export function followCoreEvents(queryClient: QueryClient): () => void {
    const names = [...new Set([...everything, ...Object.keys(invalidates)])] as (keyof CoreEvents)[]
    const pending = new Set<keyof CoreEvents>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let since = 0
    const flush = () => {
        timer = null
        const batch = [...pending]
        pending.clear()
        const all = batch.find((name) => everything.includes(name))
        for (const name of all ? [all] : batch) invalidate(queryClient, name)
    }
    const heard = (name: keyof CoreEvents) => {
        pending.add(name)
        const now = Date.now()
        if (timer === null) since = now
        else clearTimeout(timer)
        timer = setTimeout(flush, Math.min(QUIET, Math.max(0, since + MAX_WAIT - now)))
    }
    const offs = names.map((name) => Events.On(name, () => heard(name)))
    return () => {
        for (const off of offs) off()
        if (timer !== null) clearTimeout(timer)
        pending.clear()
    }
}

export function useCoreEvents(queryClient: QueryClient) {
    useEffect(() => followCoreEvents(queryClient), [queryClient])
}

export const shellKeys = {
    autostart: ['shell', 'autostart'],
    pathLink: ['shell', 'path-link'],
    agents: ['shell', 'agents'],
} as const

export function followShellEvents(queryClient: QueryClient): () => void {
    const offs = [
        autostart.onChanged((on) => queryClient.setQueryData(shellKeys.autostart, on)),
        pathLink.onChanged((state) => queryClient.setQueryData(shellKeys.pathLink, state)),
        agents.onChanged((status) =>
            queryClient.setQueryData<AgentsInfo>(
                shellKeys.agents,
                (old) => old && { ...old, ...status }
            )
        ),
    ]
    return () => {
        for (const off of offs) off()
    }
}

export function useShellEvents(queryClient: QueryClient) {
    useEffect(() => followShellEvents(queryClient), [queryClient])
}

export function onLive<N extends keyof CoreEvents>(
    name: N,
    handler: (data: CoreEvents[N]) => void
): () => void {
    return Events.On(name, (ev) => handler(ev.data as CoreEvents[N]))
}

export function onResync(handler: () => void): () => void {
    return Events.On('core.resync', () => handler())
}
