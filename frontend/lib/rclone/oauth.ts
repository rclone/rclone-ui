import { writeText } from '../api/clipboard'
import { handoff, message } from '../api/dialog'
import { rcFetch } from '../api/rc'
import { rpc } from '../api/rpc'
import { openUrl } from '../api/shell'
import { UserCancelledError, formatErrorMessage } from '../errors'

// An OAuth login runs inside a blocking rc call (`config/create`, `config/update`): the daemon
// starts its auth server and waits for the code. It is told to open no browser, so the link
// comes from `config/oauthstatus` and the page offers it. rclone 1.75 added that call and
// `config/oauthstop`; every login goes through them, so one somebody walked away from never
// holds the port against the next one. MIN_RCLONE_VERSION is 1.75 for exactly this.

export interface OAuthStatus {
    status: 'running' | 'stopped'
    authUrl?: string
}

// Neither call is among the SDK's typed paths.
async function call<T>(path: string): Promise<T> {
    const response = await rcFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    })
    const body = (await response.json().catch(() => ({}))) as T & { error?: string }
    if (!response.ok) throw new Error(body.error ?? `${path}: ${response.status}`)
    return body
}

export const oauthStatus = () => call<OAuthStatus>('config/oauthstatus')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Stops the running login; nothing to do when none runs. */
export async function oauthStop(): Promise<void> {
    await call('config/oauthstop').catch((error: Error) => {
        if (!/no oauth authentication is in progress/i.test(error.message)) throw error
    })
}

/**
 * Before a login starts: a previous one that was never finished keeps rclone's auth server on
 * its port, and the new one could not bind it. A daemon without the call (rclone before 1.75)
 * is left alone.
 */
export async function stopStrayOAuth(): Promise<void> {
    let status: OAuthStatus
    try {
        status = await oauthStatus()
    } catch (error) {
        console.warn('[oauth] status unavailable, not stopping anything', error)
        return
    }
    if (status.status !== 'running') return
    console.warn('[oauth] stopping a login that was still running')
    await oauthStop()
    // The stop returns before the old server's socket is closed (rclone closes it as the
    // blocked call unwinds); the new login binds the same port, so give that a moment.
    await sleep(500)
}

/**
 * rclone never opens the browser itself: the page shows the link and the person decides where
 * to finish. The daemon's browser would be the wrong machine's anyway. The key is ephemeral
 * (`config_` prefix): never written to the config file.
 */
export function loginParameters(): Record<string, string> {
    return { config_auth_no_browser: 'true' }
}

/**
 * Approving on a machine that has a browser, while rclone keeps waiting on this one. What is
 * carried over is the provider's own consent page, not rclone's link: rclone's redirect address
 * is its loopback, which on the other machine reaches nothing. Approving there ends on a page
 * that cannot load, and its address carries the code — pasted back, the server replays it to
 * rclone here and the blocked call finishes.
 *
 * Returns true when a code was delivered, false to go back to the buttons.
 */
async function handOff(target: string): Promise<boolean> {
    let link: string
    try {
        link = await rpc<string>('oauth_auth_link', {})
    } catch (error) {
        await message(`The sign-in link could not be prepared. ${formatErrorMessage(error)}`, {
            title: 'Sign in',
            kind: 'error',
        })
        return false
    }
    let note = ''
    while (true) {
        const pasted = await handoff({
            title: 'Finish on another machine',
            message: `${note}Open the link below on a machine with a browser and approve the access${target}. It will finish on a page that cannot load — paste that page's address back here.`,
            link,
            linkLabel: 'Open this link on the other machine',
            inputLabel: 'Then paste the address it lands on',
            confirmLabel: 'Finish sign-in',
        })
        if (pasted === null) return false
        let code: string | null = null
        let state: string | null = null
        try {
            const parsed = new URL(pasted.trim())
            code = parsed.searchParams.get('code')
            state = parsed.searchParams.get('state')
        } catch {
            // Not a URL at all: fall through to the same complaint as a URL without a code.
        }
        if (!code || !state) {
            note =
                'That address carries no sign-in code. Paste the whole address, including everything after the question mark.\n\n'
            continue
        }
        try {
            await rpc('oauth_deliver_code', { code, state })
            return true
        } catch (error) {
            note = `${formatErrorMessage(error)}\n\n`
        }
    }
}

/**
 * Offers the sign-in link: one press opens it here, the other copies it to finish in another
 * browser (or on another machine), and either leaves rclone waiting. Copying re-asks rather than
 * closing, so the login still has something to cancel it with once the link has been used.
 *
 * `onCancel` is how the caller stops its own login: a creation aborts the controller it passed
 * to `attendLogin`, so the failure arrives as a cancellation and the half-written config section
 * is removed with it. Without one, stopping the daemon is all there is to do.
 */
export async function presentSignIn(
    url: string,
    { what, onCancel }: { what?: string; onCancel?: () => void } = {}
): Promise<void> {
    const target = what ? ` to "${what}"` : ''
    for (let copied = false; ; copied = true) {
        const pressed = await message(
            copied
                ? `Link copied. Paste it into a browser to finish signing in${target}, then come back here.`
                : `Rclone is waiting for you to sign in${target}. Open the link here, or copy it to finish in another browser.`,
            {
                title: 'Sign in',
                kind: 'info',
                buttons: {
                    ok: 'Open in browser',
                    extra: 'Copy link',
                    second: 'Another machine',
                    cancel: 'Cancel sign-in',
                },
            }
        )
        if (pressed === 'Copy link') {
            await writeText(url)
            continue
        }
        if (pressed === 'Another machine') {
            if (await handOff(target)) return
            continue
        }
        if (pressed === 'Open in browser') await openUrl(url)
        else if (onCancel) onCancel()
        else await oauthStop()
        return
    }
}

/**
 * Runs the blocking rc call of a login, watching the daemon for the auth server and handing its
 * URL to `onAuthUrl` once. An abort stops the login on the daemon, which then fails the call;
 * that failure comes back as a cancellation.
 */
export async function attendLogin<T>(
    login: () => Promise<T>,
    { onAuthUrl, signal }: { onAuthUrl?: (url: string) => void; signal?: AbortSignal } = {}
): Promise<T> {
    if (signal?.aborted) throw new UserCancelledError('Login cancelled')
    let settled = false
    let cancelled = false
    const onAbort = () => {
        cancelled = true
        oauthStop().catch((error) => console.warn('[oauth] stop failed', error))
    }
    signal?.addEventListener('abort', onAbort)

    const watch = async () => {
        while (!settled) {
            await sleep(500)
            if (settled) return
            const status = await oauthStatus().catch(() => null)
            if (status?.status === 'running' && status.authUrl) {
                onAuthUrl?.(status.authUrl)
                return
            }
        }
    }
    if (onAuthUrl) void watch()

    try {
        return await login()
    } catch (error) {
        if (cancelled) throw new UserCancelledError('Login cancelled')
        throw error
    } finally {
        settled = true
        signal?.removeEventListener('abort', onAbort)
    }
}
