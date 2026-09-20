import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { stateStorage, watchDoc } from '@/server/state'
import { type Template, hasTemplatePaths } from '@/lib/rclone/templatePaths'
import type { MountRequest } from '@/server/app'

// The one persisted document (`<data dir>/state/app.json`, served as `/api/state/app`).
const APP_DOC = 'app'

/** The Dashboard's getting-started steps, by the key each one is recorded under. */
export type OnboardingStep = 'remote' | 'commander' | 'transfer' | 'team'

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
        /** rclone's `mount/mount` body, built when this was saved; the server replays it at start. */
        request?: MountRequest
    }
}

interface PersistedState {
    templates: Template[]
    addTemplate: (
        name: string,
        operation: Template['tags'][number],
        options: Template['options'],
        paths?: Template['paths']
    ) => void

    // Notification targets are NOT here: they live in a Rust-owned store
    // (notifications/targets.json), because the server both reads them and writes back what
    // each delivery did, with no page involved.

    acknowledgements: string[]

    /** Local disks and folders the Commander's sidebar leaves out (Settings › Interface). */
    hiddenLocalPaths: string[]
    setLocalPathHidden: (path: string, hidden: boolean) => void

    /** The Dashboard's getting-started timeline: the steps seen done, and whether it was closed. */
    onboarding: { dismissed: boolean; completed: OnboardingStep[] }
    completeOnboardingStep: (step: OnboardingStep) => void
    dismissOnboarding: () => void

    /** The Download page sends no link to the outside service that resolves page addresses. */
    disableLinkResolution: boolean
    setDisableLinkResolution: (disabled: boolean) => void

    // At startup a newer stable release replaces the server's own rclone. When off, or when the
    // server may not write there, it notifies once per new version instead.
    autoUpdateRclone: boolean
    setAutoUpdateRclone: (enabled: boolean) => void

    // --- Written by the server; read here. -----------------------------------------------
    // Declared with `undefined` defaults even though no page writes them: a rehydrate starts
    // from the defaults (`merge` below), so a key the server removed comes back as undefined and
    // the page's next write neither sets nor unsets it. Undeclared, the stale in-memory value
    // would survive the rehydrate and be written back.

    /** Settings › Rclone's custom binary (`rclone_set_custom`, `rclone_install`). */
    rclonePath: string | undefined
    /** Which rclone version the user was already told about (`lifecycle/resolve.rs`). */
    lastNotifiedRcloneVersion: string | undefined
    /** The daemon's proxy and limits, saved through `daemon_settings_set`. */
    proxy: { url: string; ignoredHosts: string[] } | undefined
    // The budgets one rclone process shares across every transfer. Empty and 0 mean not set.
    limits: { bwLimit: string; tpsLimit: number; tpsLimitBurst: number } | undefined

    // --- Remotes, as this server knows them. ------------------------------------------------

    remoteConfigs: Record<string, RemoteConfig>
    mergeRemoteConfig: (remote: string, config: RemoteConfig) => void

    favoritePaths: { remote: string; path: string; added: number }[]

    // When each remote was first listed. rclone keeps no "added" time and lists alphabetically;
    // this is what lets the sidebar put the newest remotes first.
    remoteFirstSeen: Record<string, number>
    noteRemotes: (names: string[]) => void

}

type PersistedData = Pick<
    PersistedState,
    | 'templates'
    | 'acknowledgements'
    | 'hiddenLocalPaths'
    | 'onboarding'
    | 'disableLinkResolution'
    | 'autoUpdateRclone'
    | 'rclonePath'
    | 'lastNotifiedRcloneVersion'
    | 'proxy'
    | 'limits'
    | 'remoteConfigs'
    | 'favoritePaths'
    | 'remoteFirstSeen'
>

/** What the document holds before anything is saved. Every data key is here, and only here. */
const DEFAULTS: PersistedData = {
    templates: [],
    acknowledgements: [],
    hiddenLocalPaths: [],
    onboarding: { dismissed: false, completed: [] },
    disableLinkResolution: false,
    autoUpdateRclone: true,
    rclonePath: undefined,
    lastNotifiedRcloneVersion: undefined,
    proxy: undefined,
    limits: undefined,
    remoteConfigs: {},
    favoritePaths: [],
    remoteFirstSeen: {},
}

export const usePersistedStore = create<PersistedState>()(
    persist(
        (set) => ({
            ...DEFAULTS,
            addTemplate: (name, operation, options, paths) =>
                set((state) => ({
                    templates: [
                        ...state.templates,
                        // `paths` is left off entirely when the page had none.
                        {
                            id: crypto.randomUUID(),
                            name,
                            tags: [operation],
                            options,
                            ...(hasTemplatePaths(paths) ? { paths } : {}),
                        },
                    ],
                })),

            setLocalPathHidden: (path: string, hidden: boolean) =>
                set((state) => ({
                    hiddenLocalPaths: hidden
                        ? state.hiddenLocalPaths.includes(path)
                            ? state.hiddenLocalPaths
                            : [...state.hiddenLocalPaths, path]
                        : state.hiddenLocalPaths.filter((entry) => entry !== path),
                })),

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

            setDisableLinkResolution: (disabled: boolean) =>
                set((_) => ({ disableLinkResolution: disabled })),

            setAutoUpdateRclone: (enabled: boolean) => set((_) => ({ autoUpdateRclone: enabled })),

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

        }),
        {
            name: 'store',
            storage: createJSONStorage(() => stateStorage(APP_DOC)),
            // The shell loads the document before anything renders (`initStore`): a first render
            // that set state before hydration would write defaults over what is saved.
            skipHydration: true,
            // A rehydrate starts from the defaults: a key another writer removed from the
            // document must not survive in the store and be written back.
            merge: (persisted, current) => ({
                ...current,
                ...DEFAULTS,
                ...((persisted as Partial<PersistedState> | null | undefined) ?? {}),
            }),
            version: 1,
        }
    )
)

/** Loads the document into the store; the shell awaits it before anything renders. */
export async function initStore(): Promise<void> {
    await usePersistedStore.persist.rehydrate()
}

// Another page or the server changed the document: reload it.
watchDoc(APP_DOC, () => usePersistedStore.persist.rehydrate())
