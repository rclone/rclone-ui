import { LazyStore } from '@tauri-apps/plugin-store'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ConfigFile } from '../types/config'
import type { ScheduledTask } from '../types/schedules'
import { createTauriStateStorage, waitForStoreHydration } from './lib'

let activeHostId: string | null = null
let activeStore: LazyStore | null = null
let disposeKeyChange: (() => void) | null = null

export async function initHostStore(hostId: string) {
    if (activeHostId === hostId && activeStore) {
        await waitForStoreHydration(() => useHostStore.persist.hasHydrated())
        console.log('[waitForHostStoreHydration] host store hydrated')
        return
    }

    console.log('[HostStore] Initializing for host:', hostId)
    activeHostId = hostId
    activeStore = new LazyStore(`hosts/${hostId}/store.json`)

    if (disposeKeyChange) {
        try {
            disposeKeyChange()
        } catch {}
        disposeKeyChange = null
    }

    try {
        disposeKeyChange = await activeStore.onKeyChange('host-store', async () => {
            await useHostStore.persist.rehydrate()
        })
    } catch (err) {
        console.error('[HostStore] failed to register onKeyChange listener', err)
    }

    // trigger a rehydration to load the new file's content into the store
    await useHostStore.persist.rehydrate()
}

/**
 * Durably flushes the host store to disk and awaits it. The persist middleware writes asynchronously
 * (a bare `set()` returns before the file is written), leaving a crash window between a Rust
 * filesystem mutation and its state being persisted. Call this right after a config-sync state write
 * so the on-disk store matches the filesystem before proceeding. tauri-plugin-store serializes its
 * operations, so the middleware's set lands before this save. Best-effort: a failed flush is logged,
 * not thrown — the divergence carries no config-file data loss and self-heals on the next reconcile.
 */
export async function flushHostStore(): Promise<void> {
    if (!activeStore) return
    try {
        await activeStore.save()
    } catch (error) {
        console.error('[flushHostStore] failed to flush host store', error)
    }
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
    }
}

interface HostState {
    remoteConfigs: Record<string, RemoteConfig>
    setRemoteConfig: (remote: string, config: RemoteConfig) => void
    mergeRemoteConfig: (remote: string, config: RemoteConfig) => void

    proxy:
        | {
              url: string
              ignoredHosts: string[]
          }
        | undefined

    favoritePaths: { remote: string; path: string; added: number }[]

    scheduledTasks: ScheduledTask[]
    addScheduledTask: (task: Omit<ScheduledTask, 'id'>) => string
    removeScheduledTask: (id: string) => void
    updateScheduledTask: (id: string, task: Partial<ScheduledTask>) => void

    configFiles: ConfigFile[]
    addConfigFile: (configFile: ConfigFile) => void
    removeConfigFile: (id: string) => void
    activeConfigId: string | null
    setActiveConfigFile: (id: string) => void
    updateConfigFile: (id: string, configFile: Partial<ConfigFile>) => void

    lastSkippedVersion: string | undefined

    // Resolved-once location of the "default" rclone config for this host. Pinned so switching
    // the rclone binary never relocates where the user's remotes are read from.
    defaultConfigPath: string | undefined
    setDefaultConfigPath: (path: string | undefined) => void

    // User intent to keep the system rclone config path symlinked to the active config, so a
    // terminal `rclone` shares the app's remotes. Drives reconcile on startup/switch/activation.
    // Set together with the ownership marker via setConfigSyncState.
    syncConfigToSystem: boolean

    // Positive ownership marker: the exact target our config-sync symlink currently points at (null
    // when we hold no link). The ONLY proof that the system-path symlink is ours — target *location*
    // is not proof, so a user's own symlink is never misattributed to us. Passed to the config-sync
    // commands and updated from their result. Note it records the link's target, not its location, so
    // if the system path itself moves (XDG_CONFIG_HOME set/unset between sessions) a stale link at the
    // old location is left orphaned — harmless (it points at a valid app config), intentionally unswept.
    syncConfigLinkTarget: string | null
    // Atomically set both the intent and the ownership marker (a single store write, so a crash can
    // never land between them and desync intent from what we actually linked).
    setConfigSyncState: (state: { intent: boolean; linkTarget: string | null }) => void
}

export const useHostStore = create<HostState>()(
    persist(
        (set) => ({
            remoteConfigs: {},
            setRemoteConfig: (remote: string, config: RemoteConfig) =>
                set((state) => ({
                    remoteConfigs: { ...state.remoteConfigs, [remote]: config },
                })),
            mergeRemoteConfig: (remote: string, config: RemoteConfig) =>
                set((state) => ({
                    remoteConfigs: {
                        ...state.remoteConfigs,
                        [remote]: { ...state.remoteConfigs[remote], ...config },
                    },
                })),

            proxy: undefined,

            favoritePaths: [],

            scheduledTasks: [],
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

            configFiles: [],
            addConfigFile: (configFile: ConfigFile) =>
                set((state) => ({
                    configFiles: [...state.configFiles, configFile],
                })),
            removeConfigFile: (id: string) =>
                set((state) => ({
                    configFiles: state.configFiles.filter((f) => f.id !== id),
                })),
            activeConfigId: null,
            setActiveConfigFile: (id: string) =>
                set((state) => ({
                    activeConfigId: state.configFiles.some((f) => f.id === id) ? id : null,
                })),
            updateConfigFile: (id: string, configFile: Partial<ConfigFile>) =>
                set((state) => ({
                    configFiles: state.configFiles.map((f) =>
                        f.id === id ? { ...f, ...configFile } : f
                    ),
                })),

            lastSkippedVersion: undefined,

            defaultConfigPath: undefined,
            setDefaultConfigPath: (path: string | undefined) =>
                set((_) => ({ defaultConfigPath: path })),

            syncConfigToSystem: false,
            syncConfigLinkTarget: null,
            setConfigSyncState: ({ intent, linkTarget }) =>
                set((_) => ({ syncConfigToSystem: intent, syncConfigLinkTarget: linkTarget })),
        }),
        {
            name: 'host-store',
            storage: createJSONStorage(() => createTauriStateStorage(() => activeStore)),
            skipHydration: true,
            version: 2,
            migrate: (persistedState, version) => {
                if (!persistedState) {
                    return persistedState
                }
                let state = persistedState as Record<string, unknown>

                // - The full active ConfigFile object collapses to just its id. Also handles the
                //   version-1 blob written by the persisted-store's legacy migration, whose
                //   configFiles can be undefined.
                // - Scheduling moved to the OS scheduler. Runtime fields (isRunning/currentRunId/
                //   lastRun/lastRunError) now live in the scheduler's run history; tasks gain a
                //   per-task binary. Pure reshape — OS registration happens in the startup
                //   reconcile.
                if (version < 2) {
                    const { activeConfigFile, configFiles, ...rest } = state as {
                        activeConfigFile?: ConfigFile | null
                        configFiles?: ConfigFile[]
                        [key: string]: unknown
                    }
                    const activeConfigId = activeConfigFile?.id ?? null
                    const tasks = (rest.scheduledTasks as Record<string, unknown>[]) ?? []
                    state = {
                        ...rest,
                        configFiles: configFiles ?? [],
                        activeConfigId,
                        scheduledTasks: tasks.map(
                            ({ isRunning, currentRunId, lastRun, lastRunError, ...task }) => ({
                                ...task,
                                // The old scheduler silently skipped tasks whose config wasn't
                                // the active one — those have effectively been dormant, and the
                                // OS scheduler would resurrect them. Migrate them as paused so
                                // re-enabling is an explicit user choice.
                                isEnabled:
                                    (task.isEnabled ?? true) &&
                                    (!activeConfigId || task.configId === activeConfigId),
                                binaryPath: 'app-default',
                            })
                        ),
                    }
                }

                return state
            },
        }
    )
)

/** Resolves the active ConfigFile object from the stored id, or null if it no longer exists. */
export function selectActiveConfigFile(state: HostState): ConfigFile | null {
    return state.configFiles.find((f) => f.id === state.activeConfigId) ?? null
}
