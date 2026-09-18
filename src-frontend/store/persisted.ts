import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { quit as exit } from '../lib/api/app'
import { ask } from '../lib/api/dialog'
import { toolbarSetShortcut } from '../lib/api/native'
import { platform } from '../lib/api/os'
import { putDoc, stateStorage, watchDoc } from '../lib/api/state'
import type { Host } from '../lib/hosts'
import { hasTemplatePaths } from '../lib/rclone/templatePaths'
import type { SERVE_TYPES } from '../lib/rclone/constants'
import type { ConfigFile } from '../types/config'
import type { Template } from '../types/template'
import type { RemoteConfig as HostRemoteConfig } from './host'

// The app-wide document (`<app_data>/state/app.json`, served as `/api/state/app`).
const APP_DOC = 'app'

interface RemoteConfigV1 {
    disabledActions?: ('tray' | 'tray-mount' | 'tray-browse' | 'tray-remove' | 'tray-cleanup')[]

    defaultRemotePath?: string
    defaultMountPoint?: string
    mountOnStart?: boolean

    mountDefaults?: Record<string, any>
    vfsDefaults?: Record<string, any>
    filterDefaults?: Record<string, any>
    copyDefaults?: Record<string, any>
    moveDefaults?: Record<string, any>
    syncDefaults?: Record<string, any>
    configDefaults?: Record<string, any>
    serveDefaults?: Record<(typeof SERVE_TYPES)[number], Record<string, any>>
    bisyncDefaults?: Record<string, any>
    remoteDefaults?: Record<string, any>
}

interface TemplateV1 {
    id: string
    name: string
    operation?: 'copy' | 'sync' | 'move' | 'delete' | 'purge' | 'serve' | 'mount' | 'bisync'
    options: Record<string, any>
}

interface PersistedStateV1 {
    remoteConfigList: Record<string, RemoteConfigV1>

    proxy:
        | {
              url: string
              ignoredHosts: string[]
          }
        | undefined

    favoritePaths: { remote: string; path: string; added: number }[]

    settingsPass: string | undefined

    startOnBoot: boolean

    // Legacy v1 field; the v1→v2 migration never reads it (host stores own scheduling data).
    scheduledTasks: unknown[]

    templates: TemplateV1[]

    configFiles: ConfigFile[]
    activeConfigFile: ConfigFile | null

    lastSkippedVersion: string | undefined

    hideStartup: boolean

    themeV2: {
        tray: 'light' | 'dark' | undefined
    }
}

/** The Dashboard's getting-started steps, by the key each one is recorded under. */
export type OnboardingStep = 'remote' | 'commander' | 'transfer' | 'team'

interface PersistedStateV2 {
    settingsPass: string | undefined
    setSettingsPass: (pass: string | undefined) => void

    startOnBoot: boolean
    setStartOnBoot: (startOnBoot: boolean) => void

    toolbarShortcut: string | undefined
    setToolbarShortcut: (shortcut: string | undefined) => Promise<void>

    templates: Template[]
    addTemplate: (
        name: string,
        operation: Template['tags'][number],
        options: Template['options'],
        paths?: Template['paths']
    ) => void

    // Notification targets are NOT here: they live in a Rust-owned store
    // (notifications/targets.json) so the headless scheduler runner can read AND write them.

    hosts: Host[]
    currentHostId: string | null
    setCurrentHost: (id: Host['id']) => void

    hideStartup: boolean

    acknowledgements: string[]

    appearance: {
        tray: 'light' | 'dark' | 'system' | 'color'
        app: 'light' | 'dark' | 'system'
    }

    /** Local disks and folders the Commander's sidebar leaves out (Settings › Interface). */
    hiddenLocalPaths: string[]
    setLocalPathHidden: (path: string, hidden: boolean) => void

    /** The Dashboard's getting-started timeline: the steps seen done, and whether it was closed. */
    onboarding: { dismissed: boolean; completed: OnboardingStep[] }
    completeOnboardingStep: (step: OnboardingStep) => void
    dismissOnboarding: () => void

    // Absolute path of the rclone executable the app runs. Managed downloads live under
    // $APPLOCALDATA/rclone-versions/vX/, a system rclone is its PATH location, and a custom
    // binary is any other path. `undefined` triggers one-time adoption at startup.
    rclonePath: string | undefined
    setRclonePath: (path: string | undefined) => void

    // Download + switch to new stable rclone releases at startup (managed binaries only).
    // When off, the app still checks and notifies once per new version.
    autoUpdateRclone: boolean
    setAutoUpdateRclone: (enabled: boolean) => void
    lastNotifiedRcloneVersion: string | undefined
}

export const usePersistedStore = create<PersistedStateV2>()(
    persist(
        (set) => ({
            settingsPass: undefined,
            setSettingsPass: (pass: string | undefined) => set((_) => ({ settingsPass: pass })),

            startOnBoot: false,
            setStartOnBoot: (startOnBoot: boolean) => set((_) => ({ startOnBoot })),

            toolbarShortcut: undefined,
            setToolbarShortcut: async (shortcut: string | undefined) => {
                await toolbarSetShortcut(shortcut ?? null)
                set((_) => ({ toolbarShortcut: shortcut }))
            },

            templates: [],
            addTemplate: (name, operation, options, paths) =>
                set((state) => ({
                    templates: [
                        ...state.templates,
                        // `paths` is left off entirely when the page had none, so a template
                        // reads the same as one saved before templates carried them.
                        {
                            id: crypto.randomUUID(),
                            name,
                            tags: [operation],
                            options,
                            ...(hasTemplatePaths(paths) ? { paths } : {}),
                        },
                    ],
                })),

            hosts: [],
            currentHostId: null,
            setCurrentHost: (id: Host['id']) =>
                set((state) => {
                    if (!state.hosts.some((h) => h.id === id)) {
                        return {}
                    }

                    return { currentHostId: id }
                }),

            hideStartup: false,

            acknowledgements: [],

            appearance: {
                tray: platform === 'linux' ? 'color' : 'system',
                app: 'dark',
            },

            hiddenLocalPaths: [],
            setLocalPathHidden: (path: string, hidden: boolean) =>
                set((state) => ({
                    hiddenLocalPaths: hidden
                        ? state.hiddenLocalPaths.includes(path)
                            ? state.hiddenLocalPaths
                            : [...state.hiddenLocalPaths, path]
                        : state.hiddenLocalPaths.filter((entry) => entry !== path),
                })),

            onboarding: { dismissed: false, completed: [] },
            completeOnboardingStep: (step: OnboardingStep) =>
                set((state) =>
                    state.onboarding.completed.includes(step)
                        ? {}
                        : {
                              onboarding: {
                                  ...state.onboarding,
                                  completed: [...state.onboarding.completed, step],
                              },
                          }
                ),
            dismissOnboarding: () =>
                set((state) => ({ onboarding: { ...state.onboarding, dismissed: true } })),

            rclonePath: undefined,
            setRclonePath: (path: string | undefined) => set((_) => ({ rclonePath: path })),

            autoUpdateRclone: true,
            setAutoUpdateRclone: (enabled: boolean) => set((_) => ({ autoUpdateRclone: enabled })),
            lastNotifiedRcloneVersion: undefined,
        }),
        {
            name: 'store',
            storage: createJSONStorage(() => stateStorage(() => APP_DOC)),
            version: 3,
            migrate: async (persistedState, version) => {
                if (!persistedState) {
                    return persistedState as PersistedStateV2
                }

                if (version < 2) {
                    const legacyState = persistedState as PersistedStateV1

                    console.log('[Migration] Migrating from V1 to V2')

                    const newRemoteConfigs: Record<string, HostRemoteConfig> = {}
                    const newTemplates: Template[] = legacyState.templates
                        ? [
                              ...legacyState.templates.map((template) => ({
                                  ...template,
                                  tags: (template as unknown as TemplateV1).operation
                                      ? [(template as unknown as TemplateV1).operation!]
                                      : [],
                              })),
                          ]
                        : []

                    if (legacyState.remoteConfigList) {
                        for (const [key, config] of Object.entries(legacyState.remoteConfigList)) {
                            newRemoteConfigs[key] = {
                                mountOnStart: {
                                    enabled: config.mountOnStart || false,
                                    remotePath: config.defaultRemotePath || '',
                                    mountPoint: config.defaultMountPoint || '',
                                    mountOptions: config.mountDefaults || {},
                                    vfsOptions: config.vfsDefaults || {},
                                    filterOptions: config.filterDefaults || {},
                                    configOptions: config.configDefaults || {},
                                },
                            }

                            // migrate defaults to templates
                            const mergedOptions: Record<string, any> = {
                                sources: [],
                                dest: '',
                            }

                            if (
                                config.copyDefaults &&
                                Object.keys(config.copyDefaults).length > 0
                            ) {
                                mergedOptions.copyOptions = config.copyDefaults
                            }
                            if (config.vfsDefaults && Object.keys(config.vfsDefaults).length > 0) {
                                mergedOptions.vfsOptions = config.vfsDefaults
                            }
                            if (
                                config.filterDefaults &&
                                Object.keys(config.filterDefaults).length > 0
                            ) {
                                mergedOptions.filterOptions = config.filterDefaults
                            }
                            if (
                                config.mountDefaults &&
                                Object.keys(config.mountDefaults).length > 0
                            ) {
                                mergedOptions.mountOptions = config.mountDefaults
                            }
                            if (
                                config.configDefaults &&
                                Object.keys(config.configDefaults).length > 0
                            ) {
                                mergedOptions.configOptions = config.configDefaults
                            }
                            if (
                                config.syncDefaults &&
                                Object.keys(config.syncDefaults).length > 0
                            ) {
                                mergedOptions.syncOptions = config.syncDefaults
                            }
                            if (
                                config.moveDefaults &&
                                Object.keys(config.moveDefaults).length > 0
                            ) {
                                mergedOptions.moveOptions = config.moveDefaults
                            }
                            if (
                                config.bisyncDefaults &&
                                Object.keys(config.bisyncDefaults).length > 0
                            ) {
                                mergedOptions.bisyncOptions = config.bisyncDefaults
                            }

                            // check if any options have keys
                            const hasOptions = Object.values(mergedOptions).some(
                                (opt) =>
                                    typeof opt === 'object' &&
                                    opt !== null &&
                                    Object.keys(opt).length > 0
                            )

                            if (hasOptions) {
                                newTemplates.push({
                                    id: crypto.randomUUID(),
                                    name: `${key} (Defaults)`,
                                    tags: [
                                        'copy',
                                        'sync',
                                        'move',
                                        'delete',
                                        'purge',
                                        'serve',
                                        'mount',
                                        'bisync',
                                    ],
                                    options: mergedOptions,
                                })
                            }
                        }
                    }

                    const hostState = {
                        state: {
                            remoteConfigs: newRemoteConfigs,
                            proxy: legacyState.proxy,
                            favoritePaths: legacyState.favoritePaths || [],
                            scheduledTasks: [],
                            configFiles: legacyState.configFiles,
                            activeConfigFile: legacyState.activeConfigFile,
                            lastSkippedVersion: legacyState.lastSkippedVersion,
                        },
                        version: 1,
                    }

                    try {
                        await putDoc('hosts/local', hostState.version, hostState.state)
                        console.log('[Migration] Moved host-specific state to hosts/local')
                    } catch (e) {
                        console.error('[Migration] Failed to save host store', e)
                        await ask(
                            'Old data could not be migrated to V3. Please reinstall.\n\nYou can make a backup of the "store.json" file located in the app\'s directory before reinstalling.',
                            {
                                title: 'Fatal Error',
                                kind: 'error',
                            }
                        )

                        await exit()
                    }

                    return {
                        settingsPass: legacyState.settingsPass || undefined,
                        startOnBoot: legacyState.startOnBoot || false,
                        templates: newTemplates,
                        hideStartup: legacyState.hideStartup || false,
                        appearance: {
                            tray: 'system',
                            app: 'dark',
                        },
                    } as unknown as PersistedStateV2
                }

                if (version < 3) {
                    // v2 stored the full current Host object; v3 stores just its id.
                    const { currentHost, ...rest } = persistedState as PersistedStateV2 & {
                        currentHost?: Host | null
                    }
                    return {
                        ...rest,
                        currentHostId: currentHost?.id ?? null,
                    } as PersistedStateV2
                }

                return persistedState as PersistedStateV2
            },
        }
    )
)

/** Resolves the current Host object from the stored id, or null if it no longer exists. */
export function selectCurrentHost(state: PersistedStateV2): Host | null {
    return state.hosts.find((h) => h.id === state.currentHostId) ?? null
}

export function useCurrentHost(): Host | null {
    return usePersistedStore(selectCurrentHost)
}

usePersistedStore.persist.onFinishHydration((state) => {
    if (state.toolbarShortcut) {
        toolbarSetShortcut(state.toolbarShortcut).catch(() => {})
    }
})

// Another page or the server changed the document: reload it.
watchDoc(
    () => APP_DOC,
    () => usePersistedStore.persist.rehydrate()
)
