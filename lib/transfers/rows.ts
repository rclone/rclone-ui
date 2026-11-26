import { t } from '@lingui/core/macro'
import type { Bus, Transfers } from '../core/types'

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

export function percent(bytes: number, totalBytes: number) {
    return totalBytes > 0 ? Math.min(100, Math.floor((bytes * 100) / totalBytes)) : 0
}

export function isLive(state: string) {
    return state === 'running'
}

export type TransferPhase = 'preparing' | 'checking' | 'transferring'

export function phaseOf(
    state: string,
    progress: Bus.TransferProgress | null | undefined
): TransferPhase | null {
    if (!isLive(state)) return null
    if (progress && (progress.transferring.length > 0 || progress.bytes > 0)) return 'transferring'
    if (progress && progress.checking.length > 0) return 'checking'
    return 'preparing'
}
