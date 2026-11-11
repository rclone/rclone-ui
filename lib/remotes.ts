import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { remotes as api } from './core/api'
import { coreKey } from './core/query'
import { compareText } from './format'
import { onLive } from './live'
import type {
    ConfigStep,
    FsInfoView,
    HealthResult,
    Remote,
    RemoteValues,
    SessionRequest,
} from './shell/bindings/github.com/rclone/rclone-ui/core/remotes/models'

export type { ConfigStep, FsInfoView, HealthResult, Remote }

// The remotes in the config. The list includes each remote's type and cached fsinfo.
// remotes.changed and remotes.health keep the queries fresh.

/** The pseudo-remotes the navigator lists beside the real ones. */
const NOT_REMOTES = new Set(['UI_LOCAL_FS', 'UI_FAVORITES'])

export function useRemotes() {
    const query = useQuery({ queryKey: coreKey('remotes', 'List'), queryFn: () => api.List() })
    const remotes = useMemo<Remote[]>(() => query.data ?? [], [query.data])
    return { remotes, query }
}

/**
 * The remotes' names in the order that every list shows them: alphabetical, as the app's language
 * sorts them. The core lists them in the config's order, which is usually the order they were
 * created in.
 */
export function namesOf(remotes: Remote[]): string[] {
    return remotes.map((r) => r.name).sort(compareText)
}

export function useRemoteNames(): string[] {
    const { remotes } = useRemotes()
    return useMemo(() => namesOf(remotes), [remotes])
}

/**
 * Explains why `name` can't be the name of a new remote, as the core checks it while the user
 * types. The core checks rclone's naming rule, rejects one-letter names, and rejects names that
 * are already in use, because config/create would overwrite them. Returns undefined when the name
 * is fine, or when `ask` is false.
 */
export function useNameProblem(name: string, ask: boolean) {
    const { data } = useQuery({
        queryKey: coreKey('remotes', 'CheckName', { name }),
        queryFn: () => api.CheckName(name),
        enabled: ask,
        placeholderData: keepPreviousData,
    })
    return ask ? data || undefined : undefined
}

/** Every remote's health, by name: ok (with its quota), faulty, checking or unknown. */
export function useRemoteHealth() {
    return useQuery({ queryKey: coreKey('remotes', 'Health'), queryFn: () => api.Health() })
}

/** Forgets every remote's health, so that each one is checked again. */
export function recheckRemotes(): Promise<void> {
    return api.Recheck()
}

/**
 * Checks one remote again, as its edit form opens. useRemoteHealth shows it as checking until
 * remotes.health brings the result.
 */
export function checkRemote(name: string): Promise<void> {
    return api.CheckRemote(name)
}

export function deleteRemote(name: string): Promise<void> {
    return api.Delete(name)
}

/**
 * Logs in to a Filen account and returns its API key. For an account with two-factor
 * authentication, the login is rejected with an error on the `code` field until the code is
 * given.
 */
export function filenApiKey(email: string, password: string, code: string): Promise<string> {
    return api.FilenAPIKey(email, password, code)
}

/**
 * A remote's capabilities, from the cached fsinfo in the list. The core refreshes it in the
 * background, and sends remotes.changed when the new fsinfo is in.
 */
export function useFsInfo(remote: string | undefined | null) {
    const { remotes, query } = useRemotes()
    const data = useMemo<FsInfoView | undefined>(
        () =>
            remote && !NOT_REMOTES.has(remote)
                ? (remotes.find((r) => r.name === remote)?.fsinfo ?? undefined)
                : undefined,
        [remotes, remote]
    )
    return { data, isLoading: query.isLoading }
}

// Returns false while the fsinfo is still loading (undefined). A caller that wants to assume
// support until the fsinfo arrives handles that itself. Features use rclone's names
// (fs.Features.Enabled: `Purge`, `PublicLink`, …).
export function hasFeature(fsInfo: FsInfoView | undefined | null, feature: string): boolean {
    return !!fsInfo?.features[feature]
}

/** A remote's saved settings in the form the pages use, with `type` alongside the rest. */
export function remoteValues(r: RemoteValues): Record<string, string> {
    return { ...r.values, type: r.type } as Record<string, string>
}

/**
 * The query of a remote's saved settings, with `type` alongside the rest. Passwords stay
 * obscured, as rclone stores them. It is for useQueries, which reads several remotes at once.
 */
export function remoteConfigQuery(remote: string) {
    return {
        queryKey: coreKey('remotes', 'Get', { name: remote }),
        queryFn: () => api.Get(remote),
        select: remoteValues,
    }
}

/** A remote's saved settings (remoteConfigQuery), or nothing for a path that isn't a remote. */
export function useRemoteConfig(remote: string | undefined | null) {
    return useQuery({
        ...remoteConfigQuery(remote ?? ''),
        enabled: !!remote && !NOT_REMOTES.has(remote),
    })
}

const FINISHED = new Set(['done', 'failed', 'cancelled'])

export function finished(step: ConfigStep | null | undefined): boolean {
    return !!step && FINISHED.has(step.state)
}

/**
 * Starts a config session (create, update or reconnect). remotes.session events report its later
 * steps.
 */
export async function startSession(
    req: Pick<SessionRequest, 'kind' | 'name'> &
        Partial<Pick<SessionRequest, 'newName' | 'type' | 'values' | 'nonInteractive'>>
): Promise<ConfigStep> {
    return api.StartSession({
        newName: '',
        type: '',
        values: {},
        nonInteractive: false,
        ...req,
    })
}

export function answerSession(id: string, value: string): Promise<void> {
    return api.Answer(id, value)
}

/** A session that is already over is left alone. */
export function cancelSession(id: string) {
    api.CancelSession(id).catch((error: unknown) => {
        console.warn('[remotes] cancelling a session', error)
    })
}

/**
 * The step that a session is at after its question was answered: the core moves it to `working`
 * before Answer returns. Pass this step to nextStep rather than the question itself. Otherwise,
 * when rclone asks the same question again (after a wrong code, for example), nextStep sees no
 * change and keeps waiting.
 */
export function answered(step: ConfigStep): ConfigStep {
    return { ...step, state: 'working', question: null, notice: '' }
}

/**
 * Waits for the session's next step after `seen`. Returns null once the session is gone or
 * another session has replaced it. It listens for remotes.session, and also checks every few
 * seconds in case an event was missed.
 */
export function nextStep(seen: ConfigStep): Promise<ConfigStep | null> {
    const seenKey = stepKey(seen)
    return new Promise((resolve) => {
        let done = false
        let checking = false
        const stop = (step: ConfigStep | null) => {
            if (done) return
            done = true
            off()
            clearInterval(timer)
            resolve(step)
        }
        const check = async () => {
            if (done || checking) return
            checking = true
            try {
                const step = await api.CurrentSession()
                if (!step || step.id !== seen.id) stop(null)
                else if (stepKey(step) !== seenKey) stop(step)
            } catch (error) {
                console.warn('[remotes] reading the session', error)
            } finally {
                checking = false
            }
        }
        const off = onLive('remotes.session', () => check())
        const timer = setInterval(check, 3000)
        check()
    })
}

function stepKey(step: ConfigStep) {
    return [
        step.state,
        step.question ? JSON.stringify(step.question) : '',
        step.notice,
        step.authUrl,
        step.error,
    ].join('\u0000')
}
