// Follows a remote config session, and reconnects remotes whose sign-in expired. The session runs
// in the core. The pages answer rclone's questions in a dialog with the option's field (askOption),
// and open its sign-in link.
//
// When a core call fails because a remote's sign-in expired, it rejects with the `reconnect` code
// and the remote's name. The query client passes the name to offerReconnect, which:
//   1. claims the remote's dialog in the core (remotes Claim), so only one window in the app asks.
//   2. asks the user whether to reconnect.
//   3. starts a `reconnect` session and follows it.
//   4. releases the claim, whether or not the reconnect worked.

import { t } from '@lingui/core/macro'
import { useEffect } from 'react'
import { remotes as api } from './core/api'
import { coreError, formatErrorMessage } from './errors'
import {
    answered,
    answerSession,
    type ConfigStep,
    cancelSession,
    finished,
    nextStep,
    startSession,
} from './remotes'
import { ask, askOption, clipboard, message, openUrl, windowName } from './shell'

/** The remote whose sign-in expired, when the error reports one. */
export function needsReconnect(error: unknown): string | null {
    const e = coreError(error)
    return (e?.code === 'reconnect' && e.remote) || null
}

/**
 * Offers a session's sign-in when its step is `authorize`. The link opens in the browser, and
 * the dialog can copy it. Cancelling ends the session. When `signal` aborts, because the session
 * moved on, finished or failed, the dialog closes by itself.
 */
export async function presentSignIn(
    step: ConfigStep,
    what?: string,
    signal?: AbortSignal
): Promise<void> {
    const url = step.authUrl
    if (!url) return
    // The dialog answers with the label of the button that was pressed.
    const done = t({
        message: 'Done',
        comment: 'Button of the sign-in dialog: the user has finished signing in in the browser.',
    })
    const copyLink = t`Copy link`
    const cancel = t`Cancel sign-in`
    await openUrl(url)
    for (let copied = false; ; copied = true) {
        const pressed = await message(signInText(copied, what), {
            title: t({
                message: 'Sign in',
                comment: 'Title of the dialog that waits while the user signs in in the browser.',
            }),
            kind: 'info',
            buttons: { ok: done, extra: copyLink, cancel },
            signal,
        })
        // A closed dialog answers with its Cancel label, which mustn't cancel the session.
        if (signal?.aborted) return
        if (pressed === copyLink) {
            await clipboard.setText(url)
            continue
        }
        if (pressed === cancel) cancelSession(step.id)
        return
    }
}

/** What the sign-in dialog says, before and after its link was copied. `what` names the remote. */
function signInText(copied: boolean, what?: string): string {
    if (!what) {
        return copied
            ? t`Link copied. Paste it into a browser to finish signing in.`
            : t`Finish signing in in your browser. Rclone is waiting for it.`
    }
    return copied
        ? t`Link copied. Paste it into a browser to finish signing in to "${what}".`
        : t`Finish signing in to "${what}" in your browser. Rclone is waiting for it.`
}

/**
 * Asks rclone's question and sends the answer. Returns false, after ending the session, when the
 * question isn't answered.
 */
async function answerQuestion(step: ConfigStep): Promise<boolean> {
    if (!step.question) {
        cancelSession(step.id)
        return false
    }
    const value = await askOption(step.question, step.notice || undefined)
    if (value === null) {
        cancelSession(step.id)
        return false
    }
    try {
        await answerSession(step.id, value)
        return true
    } catch (error) {
        cancelSession(step.id)
        throw error
    }
}

/**
 * Explains why a session failed, for a dialog. This is rclone's error, unless another program has
 * the port that rclone's sign-in listens on (the step's `busy`), in which case it says so. The
 * caller translates `fallback`.
 */
export function sessionFailure(step: ConfigStep, fallback: string): string {
    const address = step.busy
    if (address) {
        return t`Another app is using the port rclone signs in on (${address}). Close it, then try again.`
    }
    return step.error || fallback
}

/**
 * Follows a session to its end, answering its questions and offering its sign-in. `what` names
 * the remote in the dialogs. Resolves with the last step (done, failed or cancelled), or null when
 * another session replaced it.
 */
export async function followSession(first: ConfigStep, what: string): Promise<ConfigStep | null> {
    let step: ConfigStep | null = first
    let signInOffered = ''
    // The sign-in dialog on screen. It closes once the session leaves the sign-in, so it never
    // waits for a Done that no longer means anything.
    let signIn: AbortController | undefined
    const closeSignIn = () => {
        signIn?.abort()
        signIn = undefined
        signInOffered = ''
    }
    try {
        while (step && !finished(step)) {
            if (step.state !== 'authorize' || step.authUrl !== signInOffered) closeSignIn()
            if (step.state === 'authorize' && step.authUrl && signInOffered !== step.authUrl) {
                // This isn't awaited, because the login can finish however the user signs in,
                // and the result may arrive while the dialog is still open.
                signInOffered = step.authUrl
                signIn = new AbortController()
                presentSignIn(step, what, signIn.signal).catch((error: unknown) =>
                    console.warn('[remotes] sign-in dialog', error)
                )
            } else if (step.state === 'question') {
                if (!(await answerQuestion(step))) return { ...step, state: 'cancelled' }
                step = answered(step)
            }
            step = await nextStep(step)
        }
        return step
    } finally {
        closeSignIn()
    }
}

/** How a reconnect ended, when it didn't fail. */
export type ReconnectOutcome = 'done' | 'cancelled'

async function runReconnect(name: string): Promise<ReconnectOutcome> {
    const end = await followSession(await startSession({ kind: 'reconnect', name }), name)
    if (end?.state === 'done') return 'done'
    if (end?.state === 'failed') throw new Error(sessionFailure(end, t`Reconnection failed`))
    return 'cancelled'
}

/** This window's name for claims. The core gives a remote's dialog to one holder at a time. */
let holder: string | undefined
function holderName() {
    holder ??= `${windowName()}-${Math.random().toString(36).slice(2, 8)}`
    return holder
}

async function withClaim<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    const claim = await api.Claim(name, holderName())
    // Another window is already asking. It reconnects for everyone, and remotes.changed reports it
    // here.
    if (!claim.granted) return null
    try {
        return await run()
    } finally {
        api.Release(name, holderName()).catch(() => undefined)
    }
}

async function reconnectDialog(name: string): Promise<boolean> {
    const confirmed = await ask(
        t`Remote "${name}" needs to be reconnected. This usually means the authentication token has expired.\n\nWould you like to reconnect now?`,
        {
            title: t`Reconnect Remote`,
            kind: 'warning',
            okLabel: t({
                message: 'Reconnect',
                comment: 'Button: signs a remote in again after its sign-in expired.',
            }),
            cancelLabel: t({
                message: 'Dismiss',
                comment: 'Button: closes the question without reconnecting the remote.',
            }),
        }
    )
    if (!confirmed) return false
    try {
        if ((await runReconnect(name)) !== 'done') return false
    } catch (error) {
        await message(formatErrorMessage(error, t`Reconnection failed`), {
            title: t`Reconnect Error`,
            kind: 'error',
        })
        return false
    }
    await message(t`Remote "${name}" has been reconnected successfully.`, {
        title: t({ message: 'Reconnected', comment: 'Title: a remote was signed in again.' }),
        kind: 'info',
    })
    return true
}

/** The reconnect that this window is running for each remote. There is one at a time per remote. */
const offers = new Map<string, Promise<boolean>>()

/**
 * Offers to reconnect `name`, once at a time per remote. Resolves true when it was reconnected in
 * this window, so that the caller can retry what failed.
 */
export function offerReconnect(name: string): Promise<boolean> {
    let offer = offers.get(name)
    if (!offer) {
        offer = withClaim(name, () => reconnectDialog(name))
            .then((ok) => !!ok)
            .catch((error: unknown) => {
                console.warn('[reconnect] claiming the dialog failed', error)
                return false
            })
            .finally(() => offers.delete(name))
        offers.set(name, offer)
    }
    return offer
}

/**
 * Reconnects `name` without asking first, because the user pressed Reconnect on it. Rejects with
 * the error. If an offer for it is already on screen, this waits for that offer instead.
 */
export function reconnectRemote(name: string): Promise<ReconnectOutcome> {
    const offer = offers.get(name)
    if (offer) return offer.then((ok) => (ok ? 'done' : 'cancelled'))
    const run = withClaim(name, () => runReconnect(name)).then((outcome) => {
        if (outcome === null) throw new Error(t`Another window is already reconnecting "${name}".`)
        return outcome
    })
    offers.set(
        name,
        run.then(
            (outcome) => outcome === 'done',
            () => false
        )
    )
    return run.finally(() => offers.delete(name))
}

/**
 * Offers to reconnect when a read reports that the remote's sign-in expired (a job's `reconnect`
 * field). Calls `retry` once the remote was reconnected in this window.
 */
export function useReconnectOffer(name: string | undefined, retry: () => void) {
    useEffect(() => {
        if (!name) return
        let current = true
        offerReconnect(name).then((reconnected) => {
            if (reconnected && current) retry()
        })
        return () => {
            current = false
        }
    }, [name, retry])
}
