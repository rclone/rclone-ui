// How the transfer pages show a transfer's state and numbers. The rows themselves (the record,
// the live numbers and the totals) come from the core (`core/transfers`), so this file has only
// display logic.

import { t } from '@lingui/core/macro'
import type { Bus, Transfers } from '../core/types'

/**
 * The label and color for a transfer that has ended, shown in the list, in its drawer and in the
 * Commander's bar. States that are not an end (queued, running) have no entry.
 */
export const ENDED: Partial<
    Record<Transfers.State, { label: string; color: 'primary' | 'danger' | 'warning' | 'default' }>
> = {
    completed: {
        label: t({ message: 'Finished', context: 'state of a transfer' }),
        color: 'primary',
    },
    failed: { label: t({ message: 'Failed', context: 'state of a transfer' }), color: 'danger' },
    stopped: { label: t({ message: 'Stopped', context: 'state of a transfer' }), color: 'default' },
    interrupted: {
        label: t({
            message: 'Interrupted',
            context: 'state of a transfer',
            comment: 'The app stopped while the transfer was running.',
        }),
        color: 'warning',
    },
}

/** Whole percent of `totalBytes`, or 0 while the total is unknown. */
export function percent(bytes: number, totalBytes: number) {
    return totalBytes > 0 ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : 0
}

/** Whether live numbers (`transfers.progress`) arrive for a transfer. That is only while it runs. */
export function isLive(state: string) {
    return state === 'running'
}

export type TransferPhase = 'preparing' | 'checking' | 'transferring'

/**
 * Returns the phase of a running transfer from its live numbers: moving bytes, checking files, or
 * still preparing. Returns null when it isn't running. `progress` is missing until the first
 * `transfers.progress` event for the transfer.
 */
export function phaseOf(
    state: string,
    progress: Bus.TransferProgress | null | undefined
): TransferPhase | null {
    if (!isLive(state)) return null
    if (progress && (progress.transferring.length > 0 || progress.bytes > 0)) return 'transferring'
    if (progress && progress.checking.length > 0) return 'checking'
    return 'preparing'
}
