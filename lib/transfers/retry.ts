// Text for the retry page and the transfer page about what failed and what a rerun does. Pure.
// The core decides what can be retried (`Retryable`).

import { t } from '@lingui/core/macro'

/**
 * Returns the reason at the end of an error. rclone's errors start with the paths involved,
 * which the row already shows, and end with the reason. A clamped line should show the reason,
 * so the prefix is dropped. The full text is still shown on hover.
 */
export function errorReason(error: string): string {
    const reason = error.split(': ').pop()?.trim()
    return reason || error.trim()
}

/** Describes what rerunning the whole operation does with work that already finished. */
export function rerunEffect(operation: string) {
    if (operation === 'move') return t`Files that already moved are no longer at the source.`
    if (operation === 'delete' || operation === 'purge') {
        return t`Files that were already deleted are skipped.`
    }
    return t`Files that already arrived are skipped.`
}
