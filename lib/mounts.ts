// The mounts, as the pages use them. Each mount is a child process of the core, running on the
// config it was started with (core/mounts). mounts.changed keeps the queries fresh and reports
// when a start has succeeded or failed.

import { t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { mounts as api } from './core/api'
import { coreKey } from './core/query'
import type { Mounts, Operations } from './core/types'
import { coreError, formatErrorMessage } from './errors'
import { onLive, onResync } from './live'
import { ask, message, openUrl, platform } from './shell'

const UPLOADS_POLL_MS = 3000

/**
 * How often to fetch the mounts again. mounts.changed is only sent when a mount's state changes,
 * not as its uploads finish, so the list is polled while some uploads are pending. Returns false
 * otherwise.
 */
export function uploadsPollInterval(
    mounts: readonly Pick<Mounts.MountRow, 'uploadsPending'>[] = []
) {
    return mounts.some((mount) => mount.uploadsPending > 0) ? UPLOADS_POLL_MS : false
}

/**
 * Returns the running mounts, oldest first, each with its upload queue read along with the list.
 * Also returns the list's query, so that callers can tell a list that didn't load from an empty
 * one.
 */
export function useMounts() {
    const query = useQuery({
        queryKey: coreKey('mounts', 'List', { uploads: true }),
        queryFn: () => api.List(true),
        refetchInterval: (q) => uploadsPollInterval(q.state.data),
    })
    const mounts = useMemo<Mounts.MountRow[]>(() => query.data ?? [], [query.data])
    return { mounts, query }
}

/** The stopped mounts whose cache still holds uploads, newest first, and the list's query. */
export function useStoppedMounts() {
    const query = useQuery({ queryKey: coreKey('mounts', 'Stopped'), queryFn: () => api.Stopped() })
    const mounts = useMemo<Mounts.StoppedRow[]>(() => query.data ?? [], [query.data])
    return { mounts, query }
}

/**
 * The automounts, each with whether it is mounted now. An automount mounts a folder of a remote
 * each time the app starts. automounts.changed and mounts.changed keep the list fresh.
 */
export function useAutomounts() {
    return useQuery({
        queryKey: coreKey('mounts', 'ListAutomounts'),
        queryFn: () => api.ListAutomounts(),
    })
}

/** An empty id creates an automount. The core rejects a bad field by its name (refusedFields). */
export function saveAutomount(automount: Mounts.Automount): Promise<Mounts.Automount> {
    return api.SaveAutomount(automount)
}

/** A mount that the automount started keeps running. */
export async function deleteAutomount(id: string): Promise<void> {
    await api.DeleteAutomount(id)
}

/** Whether this computer can mount now, or undefined until that is known. */
export function useMountSupport() {
    return useQuery({ queryKey: coreKey('mounts', 'Support'), queryFn: () => api.Support() }).data
}

/**
 * Thrown when a mount didn't start. The message is the reason, from rclone or the core.
 * `cannotMount` is true when the core said that this computer can't mount, so the page explains
 * how to set it up instead.
 */
export class MountFailedError extends Error {
    readonly cannotMount: boolean

    constructor(message: string, cannotMount = false) {
        super(message)
        this.cannotMount = cannotMount
    }
}

/** Whether a failed start should open the can't-mount dialog rather than show its error. */
export function cannotMount(error: unknown): boolean {
    return !(error instanceof MountFailedError) || error.cannotMount
}

/**
 * Follows a child process that the core is starting, until mounts.changed or serves.changed
 * reports that it runs (resolves) or failed (rejects with its error). It listens for the events
 * before it calls `start`, because the child may be up before `start` returns. Events aren't
 * replayed, so after events were missed (core.resync) it reads the row again with `row`. A
 * running row resolves, a missing row rejects, and anything else keeps waiting for the events.
 * `failed` gets the error and, for a mount, whether this computer can't mount.
 */
export function followStart<T extends { id: string }>(
    event: 'mounts.changed' | 'serves.changed',
    start: () => Promise<T>,
    row: (id: string) => Promise<{ running: boolean } | undefined>,
    failed: (message: string, cannotMount: boolean) => Error
): Promise<T> {
    type Result = { state: string; error: string; cannotMount: boolean }
    const seen = new Map<string, Result>()
    let wanted: string | undefined
    let settle: ((result: Result) => void) | undefined
    let recheck: (() => void) | undefined
    let sawResync = false
    const offChange = onLive(event, (e) => {
        if (!e.id) return
        if (e.state !== 'running' && e.state !== 'failed' && e.state !== 'stopped') return
        const result = {
            state: e.state,
            error: e.error ?? '',
            cannotMount: 'cannotMount' in e && !!e.cannotMount,
        }
        if (wanted === e.id && settle) {
            settle(result)
            return
        }
        if (!seen.has(e.id)) seen.set(e.id, result)
    })
    const offResync = onResync(() => {
        if (recheck) recheck()
        else sawResync = true // start() hasn't returned yet, so recheck once it has
    })
    const off = () => {
        offChange()
        offResync()
    }
    return start().then(
        (started) =>
            new Promise<T>((resolve, reject) => {
                let done = false
                const finish = ({ state, error, cannotMount }: Result) => {
                    if (done) return // an event and a re-read can both report the result
                    done = true
                    off()
                    if (state === 'running') resolve(started)
                    else reject(failed(error || `It ${state} before it ran.`, cannotMount))
                }
                settle = finish
                recheck = () => {
                    row(started.id).then(
                        (now) => {
                            if (!now) finish({ state: 'stopped', error: '', cannotMount: false })
                            else if (now.running)
                                finish({ state: 'running', error: '', cannotMount: false })
                        },
                        // The next resync tries again. Until then, the events can still settle it.
                        () => undefined
                    )
                }
                wanted = started.id
                const early = seen.get(started.id)
                if (early) finish(early)
                else if (sawResync) recheck()
            }),
        (error) => {
            off()
            throw error
        }
    )
}

/** Reads a mount again for followStart: whether it runs, or undefined when it is gone. */
async function mountRow(id: string): Promise<{ running: boolean } | undefined> {
    const mount = (await api.List(false)).find((m) => m.id === id)
    return mount && { running: mount.state === 'running' }
}

/**
 * Starts a mount and returns it once it runs. If the mount fails, this throws a MountFailedError
 * with the child's error. On a computer that can't mount, it throws the core's rejection, and
 * explainMountSupport can tell the user why.
 */
export async function startMount(args: Operations.MountArgs): Promise<Mounts.MountRow> {
    return await followStart(
        'mounts.changed',
        () => api.Start(args),
        mountRow,
        (message, cannot) => new MountFailedError(message, cannot)
    )
}

/** Starts a stopped mount again on its cache, and returns it once it runs. */
export async function mountAgain(folder: string): Promise<Mounts.MountRow> {
    return await followStart(
        'mounts.changed',
        () => api.MountAgain(folder),
        mountRow,
        (message, cannot) => new MountFailedError(message, cannot)
    )
}

/** Mounts an automount now, and returns the mount once it runs. */
export async function mountAutomount(id: string): Promise<Mounts.MountRow> {
    return await followStart(
        'mounts.changed',
        () => api.MountAutomount(id),
        mountRow,
        (message, cannot) => new MountFailedError(message, cannot)
    )
}

/** Unmounts a mount, and returns once it is gone. */
export async function stopMount(id: string): Promise<void> {
    await api.Stop(id)
}

/** Deletes the waiting uploads of a stopped mount. */
export async function discardStopped(folder: string): Promise<void> {
    await api.Discard(folder)
}

/**
 * Installs WinFsp with the installer next to the app, then says how it went. Windows asks for
 * administrator rights first, and saying no there ends it quietly. mounts.changed then refreshes
 * every window's Support.
 */
export async function installWinFsp(): Promise<void> {
    try {
        await api.InstallWinFsp()
    } catch (error) {
        if (coreError(error)?.code !== 'canceled') {
            await message(formatErrorMessage(error), {
                title: t`WinFsp Not Installed`,
                kind: 'error',
            })
        }
        return
    }
    await message(t`WinFsp is installed. You can mount remotes now.`, {
        title: t`WinFsp Installed`,
    })
}

/**
 * On a computer that can't mount, explains why and offers a fix: WinFsp on Windows, which the app
 * installs when it has the installer and links to otherwise, and the docs elsewhere. Returns
 * false, without showing anything, when the computer can mount.
 */
export async function explainMountSupport(): Promise<boolean> {
    const support = await api.Support()
    if (support.supported) return false
    if (platform() === 'windows') {
        if (support.canInstall) {
            const wantsInstall = await ask(
                t`Rclone UI mounts remotes as drives with WinFsp, which this computer doesn't have yet. Install it now? Windows will ask for administrator rights.`,
                {
                    title: t`Install WinFsp?`,
                    kind: 'warning',
                    okLabel: t`Install`,
                    cancelLabel: t`Cancel`,
                }
            )
            if (wantsInstall) await installWinFsp()
            return true
        }
        const wantsDownload = await ask(
            t`Rclone UI mounts remotes as drives with WinFsp, which this computer doesn't have yet. Download it and install it, then start the mount again.`,
            {
                title: t`WinFsp Not Installed`,
                kind: 'warning',
                okLabel: t`Download`,
                cancelLabel: t`Cancel`,
            }
        )
        if (wantsDownload && support.docs) await openUrl(support.docs)
        return true
    }
    const reason = support.reason ?? ''
    const wantsDocs = await ask(t`${reason}\n\nSet it up on this computer, then mount again.`, {
        title: t`This computer cannot mount`,
        kind: 'warning',
        okLabel: support.docs ? t`Read how` : t`OK`,
        cancelLabel: t`Close`,
    })
    if (wantsDocs && support.docs) await openUrl(support.docs)
    return true
}
