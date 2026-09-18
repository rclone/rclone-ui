import * as Sentry from '@sentry/browser'
import { message } from './api/dialog'

// Signals that the user explicitly stopped a call (e.g. dismissed the reconnect prompt), so retry
// layers should abort instead of re-running and re-prompting.
export class UserCancelledError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UserCancelledError'
    }
}

// Coerce an unknown thrown value into a user-facing string. Mirrors the
// `error instanceof Error ? error.message : <fallback>` idiom hand-written across the app.
// Pass `String(error)` as the fallback to preserve sites that surfaced the raw value.
export function formatErrorMessage(error: unknown, fallback = 'An unknown error occurred'): string {
    return error instanceof Error ? error.message : fallback
}

interface ReportErrorOptions {
    title: string
    fallback?: string
    okLabel?: string
    // Defaults to capturing. Pass `false` for sites that did not call Sentry.captureException.
    capture?: boolean
    // When provided, forwarded to console.error before the dialog, with the error appended
    // (so `['[switchConfig] failed']` -> console.error('[switchConfig] failed', error)). Omit to
    // suppress console.error entirely for sites that never logged.
    log?: unknown[]
}

// console.error (optional) + Sentry.captureException (unless capture === false) + error dialog.
export async function reportError(error: unknown, options: ReportErrorOptions): Promise<void> {
    const { title, fallback, okLabel, capture, log } = options
    if (log) {
        console.error(...log, error)
    }
    if (capture !== false) {
        Sentry.captureException(error)
    }
    await message(formatErrorMessage(error, fallback), {
        title,
        kind: 'error',
        ...(okLabel ? { okLabel } : {}),
    })
}

// A ready-made TanStack Query `onError` handler that reports through reportError.
export function onErrorDialog(
    title: string,
    fallback?: string,
    options?: Omit<ReportErrorOptions, 'title' | 'fallback'>
): (error: unknown) => Promise<void> {
    return (error: unknown) => reportError(error, { title, fallback, ...options })
}
