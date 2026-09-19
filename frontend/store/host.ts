import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { stateStorage, watchDoc } from '../lib/api/state'
import type { ScheduledTask } from '../types/schedules'

// The host document (`<app_data>/state/hosts/local.json`, served as `/api/state/hosts/local`).
// The path still carries a host id: it is what the ledger and the schedules file themselves
// under, and this server serves exactly one of them.
const activeDoc = () => 'hosts/local'

watchDoc(activeDoc, () => useHostStore.persist.rehydrate())

/**
 * Loads the host document into the store. The store is created with `skipHydration`, because at
 * import time the page has no API layer to read the document through; the shell calls this once
 * the rest is up, and nothing renders until it has.
 */
export async function initHostStore(): Promise<void> {
    await useHostStore.persist.rehydrate()
}

export interface RemoteConfig {
    mountOnStart?: {
        enabled: boolean
        remotePath: string
        mountPoint: string
        mountOptions: Record<string, any>
        vfsOptions: Record<string, any>
        filterOptions: Record<string, any>
        configOptions: Record<string, any>
        /** Absent on host documents written before the Metadata section existed. */
        metadataOptions?: Record<string, any>
    }
}

interface HostState {
    remoteConfigs: Record<string, RemoteConfig>
    mergeRemoteConfig: (remote: string, config: RemoteConfig) => void

    proxy:
        | {
              url: string
              ignoredHosts: string[]
          }
        | undefined

    favoritePaths: { remote: string; path: string; added: number }[]

    // When each remote was first listed on this host. rclone keeps no "added" time and lists
    // alphabetically; this is what lets the sidebar put the newest remotes first.
    remoteFirstSeen: Record<string, number>
    noteRemotes: (names: string[]) => void

    scheduledTasks: ScheduledTask[]
    addScheduledTask: (task: Omit<ScheduledTask, 'id'>) => string
    removeScheduledTask: (id: string) => void
    updateScheduledTask: (id: string, task: Partial<ScheduledTask>) => void

}

type HostData = Pick<
    HostState,
    | 'remoteConfigs'
    | 'proxy'
    | 'favoritePaths'
    | 'remoteFirstSeen'
    | 'scheduledTasks'
>

/** What a host's document holds before anything is saved for it. */
const HOST_DEFAULTS: HostData = {
    remoteConfigs: {},
    proxy: undefined,
    favoritePaths: [],
    remoteFirstSeen: {},
    scheduledTasks: [],
}

export const useHostStore = create<HostState>()(
    persist(
        (set) => ({
            ...HOST_DEFAULTS,
            mergeRemoteConfig: (remote: string, config: RemoteConfig) =>
                set((state) => ({
                    remoteConfigs: {
                        ...state.remoteConfigs,
                        [remote]: { ...state.remoteConfigs[remote], ...config },
                    },
                })),

            noteRemotes: (names: string[]) =>
                set((state) => {
                    const now = Date.now()
                    const next: Record<string, number> = {}
                    let changed = Object.keys(state.remoteFirstSeen).length !== names.length
                    for (const name of names) {
                        const seen = state.remoteFirstSeen[name]
                        next[name] = seen ?? now
                        if (seen === undefined) changed = true
                    }
                    return changed ? { remoteFirstSeen: next } : {}
                }),

            addScheduledTask: (task: Omit<ScheduledTask, 'id'>) => {
                const id = crypto.randomUUID()
                set((state) => ({
                    scheduledTasks: [...state.scheduledTasks, { ...task, id } as ScheduledTask],
                }))
                return id
            },
            removeScheduledTask: (id: string) =>
                set((state) => ({
                    scheduledTasks: state.scheduledTasks.filter((t) => t.id !== id),
                })),
            updateScheduledTask: (id: string, task: Partial<ScheduledTask>) =>
                set((state) => ({
                    scheduledTasks: state.scheduledTasks.map((t) =>
                        t.id === id ? ({ ...t, ...task } as ScheduledTask) : t
                    ),
                })),
        }),
        {
            name: 'host-store',
            storage: createJSONStorage(() => stateStorage(activeDoc)),
            skipHydration: true,
            // Hydration starts from the defaults, not from whatever host was loaded before:
            // switching hosts must not carry the previous host's values into a document that
            // lacks them (and then persist them there on the next write).
            merge: (persisted, current) => ({
                ...current,
                ...HOST_DEFAULTS,
                ...((persisted as Partial<HostState> | null | undefined) ?? {}),
            }),
            version: 3,
            migrate: (persistedState, version) => {
                if (!persistedState) {
                    return persistedState
                }
                let state = persistedState as Record<string, unknown>

                // A task's runtime fields (isRunning/currentRunId/lastRun/lastRunError) moved out
                // of the store and into the scheduler's own run history. Pure reshape —
                // registering what the document lists happens in the startup reconcile.
                if (version < 2) {
                    const { activeConfigFile, ...rest } = state as {
                        activeConfigFile?: { id?: string } | null
                        [key: string]: unknown
                    }
                    const activeConfigId = activeConfigFile?.id ?? null
                    const tasks = (rest.scheduledTasks as Record<string, unknown>[]) ?? []
                    state = {
                        ...rest,
                        scheduledTasks: tasks.map(
                            ({ isRunning, currentRunId, lastRun, lastRunError, ...task }) => ({
                                ...task,
                                // A task that used to be pinned to a config other than the
                                // active one was dormant — the old scheduler silently skipped
                                // it. Runs go to the server's daemon now, so it would suddenly
                                // start firing: migrate it paused, and let re-enabling be a
                                // choice somebody makes.
                                isEnabled:
                                    (task.isEnabled ?? true) &&
                                    (!activeConfigId || task.configId === activeConfigId),
                            })
                        ),
                    }
                }

                // The app no longer has an opinion about rclone's config file: rclone resolves it
                // from its own environment. These keys described a config the app managed, and
                // `merge` would otherwise spread them back onto state forever.
                if (version < 3) {
                    const {
                        configFiles,
                        activeConfigId,
                        defaultConfigPath,
                        syncConfigToSystem,
                        syncConfigLinkTarget,
                        ...rest
                    } = state
                    state = rest
                }

                return state
            },
        }
    )
)

