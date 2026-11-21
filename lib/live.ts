// The core's events, as the pages receive them. Each one is a Wails event with the same name,
// carrying the payload that its publisher put on the core's bus (core/bus/events.go). The events
// mark the matching queries stale, and the few pages that react to an event directly listen
// through this file.

import type { QueryClient } from '@tanstack/react-query'
import { Events } from '@wailsio/runtime'
import { useEffect } from 'react'
import { type AgentsInfo, agents, autostart, pathLink } from './shell'

/** The core's events by name, with their payloads. */
export type CoreEvents = Events.CustomEvents

/**
 * The queries that each event makes stale. A target is either a domain, which covers every query
 * of its API, or `<domain>/<Method>`, which covers that one method. Either one is the start of
 * the queries' keys (coreKey). `lib/live.test.ts` checks each target against the bound APIs.
 */
export const invalidates: Partial<Record<keyof CoreEvents, string[]>> = {
    'transfers.changed': ['transfers'],
    // Where a copy or a move lands depends on what is in the destination, and a remote that
    // changed may be one of the paths.
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

/** Events after which any query may be out of date: missed events, or a change of the config (an unlock). */
const everything: (keyof CoreEvents)[] = ['core.resync', 'config.changed']

/** Marks stale the queries that an event changed (`invalidates`), or every query (`everything`). */
export function invalidate(queryClient: QueryClient, name: keyof CoreEvents) {
    if (everything.includes(name)) {
        queryClient.invalidateQueries()
        return
    }
    const targets = invalidates[name]
    if (!targets) return
    // Each target is the start of a key, `['core', domain]` or `['core', domain, Method]`. They are
    // matched in one pass, so the queries refetch once.
    const prefixes = targets.map((target) => ['core', ...target.split('/')])
    queryClient.invalidateQueries({
        predicate: (q) =>
            prefixes.some((prefix) => prefix.every((part, i) => q.queryKey[i] === part)),
    })
}

/** How long the events must stop before the queries are marked stale, in ms. */
export const QUIET = 250
/** The longest that a burst of events delays marking the queries stale, in ms. */
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
        // Everything is marked once, instead of once for each event.
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

/**
 * The keys of the queries for the state that the shell keeps rather than the core: whether the
 * app starts at login and the state of "Add rclone to PATH", which both belong to the OS, and the
 * status of the agents' server.
 */
export const shellKeys = {
    autostart: ['shell', 'autostart'],
    pathLink: ['shell', 'path-link'],
    agents: ['shell', 'agents'],
} as const

/**
 * Keeps the shell's queries (shellKeys) current, until the returned function is called. When a
 * window turns starting at login or the PATH link on or off, or the agents' server starts or
 * stops, the app tells every window, and the new value is set here. A change made in the OS's own
 * settings sends nothing, so the queries are also read again when the window gets the focus.
 */
export function followShellEvents(queryClient: QueryClient): () => void {
    const offs = [
        autostart.onChanged((on) => queryClient.setQueryData(shellKeys.autostart, on)),
        pathLink.onChanged((state) => queryClient.setQueryData(shellKeys.pathLink, state)),
        // The event leaves out the command, which stays as the query read it. Before the query's
        // first read there is nothing to update, and the read gets the new status.
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

/** Calls the handler when events were missed, so that it can fetch again what they changed. */
export function onResync(handler: () => void): () => void {
    return Events.On('core.resync', () => handler())
}
