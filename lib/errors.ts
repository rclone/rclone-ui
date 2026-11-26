import { t } from '@lingui/core/macro'
import { message } from './shell'

export class UserCancelledError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UserCancelledError'
    }
}

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
    fields?: { field: string; description: string }[]
    what?: string
    remote?: string
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
    log?: unknown[]
}

export async function reportError(error: unknown, options: ReportErrorOptions): Promise<void> {
    const { title, fallback, log } = options
    console.error(...(log ?? [title]), error)
    await message(formatErrorMessage(error, fallback), { title, kind: 'error' })
}

export function onErrorDialog(
    title: string,
    fallback?: string,
    options?: Omit<ReportErrorOptions, 'title' | 'fallback'>
): (error: unknown) => Promise<void> {
    return (error: unknown) => reportError(error, { title, fallback, ...options })
}
