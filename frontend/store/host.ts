import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { stateStorage, watchDoc } from '../lib/api/state'
import type { ScheduledTask } from '../types/schedules'

// This machine's document (`<data dir>/state/host.json`, served as `/api/state/host`).
const HOST_DOC = 'host'

watchDoc(HOST_DOC, () => useHostStore.persist.rehydrate())

/** Loads the document into the store (created with `skipHydration`); the shell calls it before anything renders. */
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
        metadataOptions: Record<string, any>
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

    // The budgets one rclone process shares across every transfer. Empty and 0 mean not set.
    limits: { bwLimit: string; tpsLimit: number; tpsLimitBurst: number } | undefined

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
    'remoteConfigs' | 'proxy' | 'limits' | 'favoritePaths' | 'remoteFirstSeen' | 'scheduledTasks'
>

/** What the document holds before anything is saved. */
const HOST_DEFAULTS: HostData = {
    remoteConfigs: {},
    proxy: undefined,
    limits: undefined,
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
            storage: createJSONStorage(() => stateStorage(HOST_DOC)),
            skipHydration: true,
            // A rehydrate starts from the defaults: a key another writer removed from the
            // document must not survive in the store and be written back.
            merge: (persisted, current) => ({
                ...current,
                ...HOST_DEFAULTS,
                ...((persisted as Partial<HostState> | null | undefined) ?? {}),
            }),
            version: 1,
        }
    )
)
