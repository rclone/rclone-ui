import { usePersistedStore } from '../../store/persisted'
import type { ScheduledTask } from '../../types/schedules'
import { renameRemoteIn, renameRemoteInArgs } from '../format'
import queryClient from '../query'
import { updateScheduledTask } from '../scheduler'
import rclone from './client'
import { readDaemonConfig, writeDaemonConfig } from './config-file'
import { renameConfigSection } from './config-text'
import { forgetRemoteHealth } from './health'

// rclone's own rule for a remote name: letters, digits, space and _ - . + @; not starting with
// - or a space, not ending with a space. config/create enforces it too; this only says so first.
const RE_REMOTE_NAME = /^[\w.+@][\w.+@ -]*$/

/**
 * Why `name` cannot be a remote's new name, or nothing when it can. One letter is refused on
 * every OS: rclone's rc takes it (only its interactive config refuses), and on Windows
 * `c:path` is then the drive C, so the remote can never be named — and a config file made
 * here may be carried to a Windows machine.
 */
export function checkRemoteName(name: string, existing: string[]): string | undefined {
    if (!name) return 'Give the remote a name.'
    if (!RE_REMOTE_NAME.test(name) || name.endsWith(' ')) {
        return 'A name may contain letters, digits, spaces and _ - . + @, and cannot start with - or a space, or end with one.'
    }
    if (name.length === 1) {
        return 'A name needs at least two characters: on Windows a single letter is a drive.'
    }
    if (existing.includes(name)) return `A remote called ${name} already exists.`
    return undefined
}

/**
 * rclone has no rename call, so the section header is renamed in the config file itself, read
 * and written through the daemon (`config-file.ts`), which reaches the app's daemon and an
 * external one alike. Every parameter stays as it was, OAuth tokens
 * included. What the app keeps by name follows: mount-on-start settings, favorites, the
 * sidebar's first-seen time, and scheduled tasks whose paths or per-remote options name it
 * (each re-registered). Anything mounted or served under the old name keeps running until it
 * is stopped.
 */
export async function renameRemote(from: string, to: string): Promise<void> {
    const { text, encrypted } = await readDaemonConfig()
    if (encrypted) {
        throw new Error(
            'The config file is encrypted, so its sections cannot be renamed in place. Decrypt it first, or rename the remote with rclone config where the daemon runs.'
        )
    }
    await writeDaemonConfig(renameConfigSection(text, from, to))
    const renamed = (await rclone('/config/get', { params: { query: { name: to } } })) as
        | Record<string, string>
        | undefined
    if (!renamed?.type) {
        throw new Error(
            `The config file now says ${to}, but rclone has not picked it up. Restart rclone and it will.`
        )
    }
    await rclone('/fscache/clear').catch(() => null)
    carryRemoteSettings(from, to)
    forgetRemoteHealth()
    queryClient.invalidateQueries({ queryKey: ['remotes'] })
    queryClient.invalidateQueries({ queryKey: ['dashboard', 'remotes'] })
    await carrySchedules(from, to)
}

function carryRemoteSettings(from: string, to: string) {
    usePersistedStore.setState((state) => {
        const { [from]: config, ...remoteConfigs } = state.remoteConfigs
        const { [from]: seen, ...remoteFirstSeen } = state.remoteFirstSeen
        return {
            remoteConfigs: config ? { ...remoteConfigs, [to]: config } : state.remoteConfigs,
            remoteFirstSeen:
                seen === undefined ? state.remoteFirstSeen : { ...remoteFirstSeen, [to]: seen },
            favoritePaths: state.favoritePaths.map((favorite) =>
                favorite.remote === from ? { ...favorite, remote: to } : favorite
            ),
        }
    })
}

async function carrySchedules(from: string, to: string) {
    const failures: string[] = []
    for (const task of usePersistedStore.getState().scheduledTasks) {
        const { args, changed } = renameRemoteInArgs(task.args, from, to)
        if (!changed) continue
        // What the sources are goes with them, under their new names.
        const kinds = task.kinds
            ? Object.fromEntries(
                  Object.entries(task.kinds).map(([path, kind]) => [
                      renameRemoteIn(path, from, to),
                      kind,
                  ])
              )
            : undefined
        try {
            await updateScheduledTask(task.id, { args, kinds } as Partial<ScheduledTask>)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            failures.push(`${task.name ?? task.id}: ${reason}`)
        }
    }
    if (failures.length > 0) {
        throw new Error(
            `The remote is now ${to}, but these schedules could not be updated:\n${failures.join('\n')}`
        )
    }
}
