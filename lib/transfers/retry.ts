import { t } from '@lingui/core/macro'

export function errorReason(error: string): string {
    const reason = error.split(': ').pop()?.trim()
    return reason || error.trim()
}

export function rerunEffect(operation: string) {
    if (operation === 'move') return t`Files that already moved are no longer at the source.`
    if (operation === 'delete' || operation === 'purge') {
        return t`Files that were already deleted are skipped.`
    }
    return t`Files that already arrived are skipped.`
}
