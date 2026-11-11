import { t } from '@lingui/core/macro'
import { useCallback } from 'react'
import { reportError } from '../../../lib/errors'
import { ask, message, openWindow, prompt } from '../../../lib/shell'
import { deleteEntry, ELSEWHERE, onTransferEnd, renameEntry } from './fsActions'
import type { Entry } from './types'

type Action = 'rename' | 'delete'

/** The message for a folder's transfer that ended in `state` without completing. */
function endMessage(action: Action, state: string, name: string): string {
    if (action === 'rename') {
        switch (state) {
            case ELSEWHERE:
                return t`The transfer renaming "${name}" is no longer in History.`
            case 'failed':
                return t`Renaming "${name}" failed.`
            case 'stopped':
                return t`Renaming "${name}" was stopped.`
            case 'interrupted':
                return t`Renaming "${name}" was interrupted.`
            default:
                return t`Renaming "${name}" did not complete.`
        }
    }
    switch (state) {
        case ELSEWHERE:
            return t`The transfer deleting "${name}" is no longer in History.`
        case 'failed':
            return t`Deleting "${name}" failed.`
        case 'stopped':
            return t`Deleting "${name}" was stopped.`
        case 'interrupted':
            return t`Deleting "${name}" was interrupted.`
        default:
            return t`Deleting "${name}" did not complete.`
    }
}

/**
 * Reports a folder rename or delete, run as a recorded transfer, that doesn't complete. This is
 * used everywhere except where the Commander's bar shows the transfer. The message links to the
 * transfer. If the core has no record of the transfer, the message says so, without a link.
 */
function reportUnlessCompleted(transferId: string, action: Action, entry: Entry) {
    onTransferEnd(transferId, async (state) => {
        if (state === 'completed') return
        const text = endMessage(action, state, entry.name)
        if (state === ELSEWHERE) {
            await message(text, { kind: 'warning' })
            return
        }
        const show = t`Show transfer`
        const pressed = await message(text, {
            title: t`Error`,
            kind: 'error',
            buttons: { ok: show, cancel: t`Close` },
        })
        if (pressed === show) {
            await openWindow(`/history?id=${encodeURIComponent(transferId)}`)
        }
    })
}

/**
 * Rename and delete for the rows of a file panel, in both the Commander and the picker. Each
 * action shows a name prompt or a confirmation, makes one call to the core (`fsActions.ts`), and
 * lists the folder again. A picker uses `afterChange` to remove the entry from its selection. A
 * page that shows the transfers it starts (the Commander's bar) passes `onTransfer`. It then
 * receives each folder's transfer with its entry, and this hook doesn't report a failed one.
 */
export default function useEntryActions(
    afterChange?: (entry: Entry) => void,
    { onTransfer }: { onTransfer?: (transferId: string, entry: Entry) => void } = {}
) {
    const rename = useCallback(
        async (entry: Entry) => {
            const name = entry.name
            const newName = await prompt({
                title: t({
                    message: 'Rename',
                    comment: 'Title of the dialog that renames a file.',
                }),
                message: t`Enter a new name for "${name}"`,
                default: entry.name,
                sensitive: false,
            })
            if (!newName || newName === entry.name) return

            try {
                const flash = await renameEntry({
                    path: entry.fullPath,
                    isDir: entry.isDir,
                    newName,
                })
                afterChange?.(entry)
                if (flash.transferId && onTransfer) onTransfer(flash.transferId, entry)
                else if (flash.transferId) reportUnlessCompleted(flash.transferId, 'rename', entry)
            } catch (error) {
                await reportError(error, {
                    title: t`Error`,
                    fallback: t`Rename failed`,
                })
            }
        },
        [afterChange, onTransfer]
    )

    const remove = useCallback(
        async (entry: Entry) => {
            // A search result is named by its path below the folder searched, which tells the
            // matches of one name apart.
            const shown = entry.displayName ?? entry.name
            const confirmed = await ask(
                entry.isDir
                    ? t`Are you sure you want to delete "${shown}" and everything in it?`
                    : t`Are you sure you want to delete "${shown}"?`,
                {
                    title: entry.isDir ? t`Delete folder` : t`Delete file`,
                    kind: 'warning',
                    destructive: true,
                    okLabel: t({
                        message: 'Delete',
                        comment: 'Button: deletes the file or folder.',
                    }),
                }
            )
            if (!confirmed) return

            try {
                const flash = await deleteEntry(entry.fullPath, entry.isDir)
                afterChange?.(entry)
                if (flash.transferId && onTransfer) onTransfer(flash.transferId, entry)
                else if (flash.transferId) reportUnlessCompleted(flash.transferId, 'delete', entry)
            } catch (error) {
                await reportError(error, {
                    title: t`Error`,
                    fallback: t`Delete failed`,
                })
            }
        },
        [afterChange, onTransfer]
    )

    return { rename, remove }
}
