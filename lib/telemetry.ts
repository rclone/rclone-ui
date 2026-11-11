// The anonymous usage data and crash reports that the app sends when the user shares them
// (core/telemetry). The pages send nothing themselves: everything goes through the core, which
// takes only the events listed there and scrubs every error's message. The switch is in Settings,
// under Privacy.

import { useQuery } from '@tanstack/react-query'
import { telemetry as api } from './core/api'
import { coreKey } from './core/query'
import { coreError } from './errors'
import { windowName } from './shell'

/**
 * The events that a page may send, each with its properties. The core refuses any other
 * (pageEvents in core/telemetry/events.go), and a property can only be a flag or a count: never
 * text, so never a path or a name.
 */
export interface PageEvents {
    disk_usage_opened: { local: boolean }
    compare_opened: Record<string, never>
    batch_rename_opened: { items: number }
}

export function track<E extends keyof PageEvents>(event: E, props: PageEvents[E]): void {
    api.Track(event, props).catch(() => undefined)
}

/** What Settings shows about sharing, beyond the user's own switch. */
export function useTelemetryInfo() {
    return useQuery({ queryKey: coreKey('telemetry', 'Info'), queryFn: () => api.Info() }).data
}

/**
 * Reports an error that this page didn't handle. A failure that the core answered with (a refused
 * form, a remote that needs a sign-in) is an answer, not a crash, and so is a cancelled call.
 */
export function reportPageError(error: unknown): void {
    if (!(error instanceof Error)) return
    if (coreError(error)) return
    if (error.name.includes('Cancel') || error.name === 'AbortError') return
    api.PageError(windowName(), error.name, error.message, error.stack ?? '').catch(() => undefined)
}

let reporting = false

export function reportPageErrors(): void {
    if (reporting) return
    reporting = true
    window.addEventListener('error', (e) => reportPageError(e.error))
    window.addEventListener('unhandledrejection', (e) => reportPageError(e.reason))
}
