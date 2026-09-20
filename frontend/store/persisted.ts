import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { stateStorage, watchDoc } from '../lib/api/state'
import { hasTemplatePaths } from '../lib/rclone/templatePaths'
import type { Template } from '../types/template'

// The app-wide document (`<data dir>/state/app.json`, served as `/api/state/app`).
const APP_DOC = 'app'

/** The Dashboard's getting-started steps, by the key each one is recorded under. */
export type OnboardingStep = 'remote' | 'commander' | 'transfer' | 'team'

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

    /**
     * The custom rclone binary of Settings › Rclone, when there is one. Only the server writes
     * it (`rclone_set_custom`, `rclone_install`); it is declared so a page's next write does not
     * drop it from the document.
     */
    rclonePath: string | undefined

    // At startup a newer stable release replaces the server's own rclone. When off, or when the
    // server may not write there, it notifies once per new version instead.
    autoUpdateRclone: boolean
    setAutoUpdateRclone: (enabled: boolean) => void
    /**
     * Which rclone version the user has already been told about. The server writes it
     * (`lifecycle/resolve.rs`) and nothing here reads it — it is declared so a page's next write
     * does not drop it from the document and make the notice repeat.
     */
    lastNotifiedRcloneVersion: string | undefined
}

export const usePersistedStore = create<PersistedState>()(
    persist(
        (set) => ({
            templates: [],
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

            acknowledgements: [],

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

            disableLinkResolution: false,
            setDisableLinkResolution: (disabled: boolean) =>
                set((_) => ({ disableLinkResolution: disabled })),

            rclonePath: undefined,

            autoUpdateRclone: true,
            setAutoUpdateRclone: (enabled: boolean) => set((_) => ({ autoUpdateRclone: enabled })),
            lastNotifiedRcloneVersion: undefined,
        }),
        {
            name: 'store',
            storage: createJSONStorage(() => stateStorage(APP_DOC)),
            version: 1,
        }
    )
)

// Another page or the server changed the document: reload it.
watchDoc(APP_DOC, () => usePersistedStore.persist.rehydrate())
