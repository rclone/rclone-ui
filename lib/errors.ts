import { t } from '@lingui/core/macro'
import { message } from './shell'

// Signals that the user explicitly stopped a call (for example, by dismissing the reconnect
// prompt), so retry layers should stop instead of running the call and prompting again.
export class UserCancelledError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UserCancelledError'
    }
}

/**
 * The core's error (core/errs): a code, the message as is, and the details that a page acts on.
 * A bound call rejects with an error whose cause is this object.
 */
export interface CoreError {
    code:
        | 'invalid'
        | 'not_found'
        | 'unsupported'
        | 'precondition'
        | 'reconnect'
        | 'failed'
        | 'internal'
        | 'canceled'
        | 'unavailable'
    message: string
    /** The rejected fields of an invalid request, keyed by the names the form uses. */
    fields?: { field: string; description: string }[]
    /**
     * The thing that doesn't exist (not_found), that isn't supported (unsupported), or that is
     * missing (precondition, such as `bisync_baseline` for a first bisync).
     */
    what?: string
    /** The remote whose sign-in expired (reconnect). */
    remote?: string
    /** The transfer that a failed start recorded. */
    transfer?: { id: string; seq: number }
}

/**
 * Returns the core's error from a bound call's rejection (its cause), or null when error isn't a
 * rejection from a bound call. A rejection without a core error is treated as `failed`.
 */
export function coreError(error: unknown): CoreError | null {
    if (error instanceof Error && error.name === 'RuntimeError') {
        const cause = (error as { cause?: unknown }).cause
        if (cause && typeof cause === 'object' && 'code' in cause) return cause as CoreError
        return { code: 'failed', message: error.message }
    }
    return null
}

/** The fields that the core rejected, with the first reason for each. Empty for other errors. */
export function refusedFields(error: unknown): Record<string, string> {
    const out: Record<string, string> = {}
    for (const v of coreError(error)?.fields ?? []) out[v.field] ??= v.description
    return out
}

/**
 * The codes for which a second try may succeed: the core couldn't handle the request yet, or
 * rclone failed.
 */
const TRANSIENT = new Set<CoreError['code']>(['unavailable', 'failed'])

/**
 * Whether trying again may give a different result. A missing file, a rejected argument or a
 * permission error stays the same, and a call that the user cancelled stays cancelled. An error
 * that doesn't come from the core, such as a plain throw, may change.
 */
export function isTransient(error: unknown): boolean {
    if (error instanceof UserCancelledError) return false
    if (error instanceof Error && error.name === 'CancelError') return false
    // Wails rejects a call to an unknown method with a ReferenceError, and a call with the wrong
    // arguments with a TypeError. Out-of-date bindings cause both, and a retry can't fix them. A
    // dropped call fails with TypeError('Failed to fetch'), which a retry can fix.
    if (error instanceof ReferenceError) return false
    if (error instanceof TypeError && error.message !== 'Failed to fetch') return false
    const e = coreError(error)
    return !e || TRANSIENT.has(e.code)
}

// The text to show the user for a thrown value. The core's message comes translated from Go, and
// the caller translates its own fallback. Pass `String(error)` as the fallback to show the raw
// value.
export function formatErrorMessage(
    error: unknown,
    fallback = t`An unknown error occurred`
): string {
    const e = coreError(error)
    if (e) return e.message || fallback
    return error instanceof Error ? error.message : fallback
}

interface ReportErrorOptions {
    title: string
    fallback?: string
    // The values passed to console.error before the dialog, with the error added at the end, so
    // `['[saveConfig] failed']` becomes console.error('[saveConfig] failed', error). Without it,
    // the title is logged with the error.
    log?: unknown[]
}

// Logs the error to the console, which the app's log keeps, and shows an error dialog.
export async function reportError(error: unknown, options: ReportErrorOptions): Promise<void> {
    const { title, fallback, log } = options
    console.error(...(log ?? [title]), error)
    await message(formatErrorMessage(error, fallback), { title, kind: 'error' })
}

// A ready-made TanStack Query `onError` handler that reports through reportError.
export function onErrorDialog(
    title: string,
    fallback?: string,
    options?: Omit<ReportErrorOptions, 'title' | 'fallback'>
): (error: unknown) => Promise<void> {
    return (error: unknown) => reportError(error, { title, fallback, ...options })
}
