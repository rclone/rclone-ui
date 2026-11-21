import { plural, t } from '@lingui/core/macro'
import type { Watchers } from '../../../lib/core/types'
import type { StatusKind } from '../../components/look/Status'

// What a watcher's row says about it. A watcher is always syncing in the background, so a run in
// progress changes nothing here: the status says how its runs went.

type Watcher = Watchers.Watcher

export interface Status {
    label: string
    kind: StatusKind
}

/** Reports whether statusOf shows the watcher as Initializing. */
export function isInitializing(w: Watcher): boolean {
    if (w.resyncing) return true
    return !w.attention && !w.paused && w.lastResult !== 'failed' && !w.baselined
}

/**
 * The status of a watcher. A Resync that hasn't ended shows Initializing, whatever the watcher
 * needed before. A failure shows Failing, because the next minute retries it. A watcher is
 * Initializing until its first merge of the two folders has succeeded (`baselined`).
 */
export function statusOf(w: Watcher): Status {
    const initializing = t({
        message: 'Initializing',
        comment: 'State of a watcher: its first merge of the two folders has not succeeded yet.',
    })
    if (w.resyncing) return { label: initializing, kind: 'active' }
    if (w.attention) return { label: t`Needs attention`, kind: 'danger' }
    if (w.paused) return { label: t`Paused`, kind: 'idle' }
    if (w.lastResult === 'failed') {
        return {
            label: t({
                message: 'Failing',
                comment: 'State of a watcher: its syncs keep failing.',
            }),
            kind: 'warning',
        }
    }
    if (!w.baselined) return { label: initializing, kind: 'active' }
    return { label: t({ message: 'Active', comment: 'State of a watcher.' }), kind: 'success' }
}

export function firstLine(error: string): string {
    return error.trim().split('\n')[0]?.trim() ?? ''
}

function deletedFolders(w: Watcher): { lost: string; other: string } | null {
    if (w.deletedSide === 'a') return { lost: w.pathA, other: w.pathB }
    if (w.deletedSide === 'b') return { lost: w.pathB, other: w.pathA }
    return null
}

/**
 * What the row says and offers after bisync stopped because many files, or all of them, were
 * deleted in one folder. `deletedSide` is empty when bisync didn't say which folder.
 */
export function deletesCopy(w: Watcher) {
    const folders = deletedFolders(w)
    if (!folders) {
        return {
            explanation: t`Many files were deleted in one of the folders since the last sync, so the watcher stopped to make sure that was intended.`,
            deleteLabel: t`Delete them in both folders too`,
            deleteQuestion: t`Delete the same files in both folders? This can't be undone.`,
        }
    }
    const { lost, other } = folders
    return {
        explanation: t`Many files were deleted in ${lost} since the last sync, so the watcher stopped to make sure that was intended.`,
        deleteLabel: t`Delete them in ${other} too`,
        deleteQuestion: t`Delete the same files in ${other}? This can't be undone.`,
    }
}

export function resyncQuestion(w: Watcher): string {
    const first = w.pathA
    const destination = w.pathB
    return t`Merge ${first} and ${destination} again? Files missing on one side are copied over, and where both have a file, the newer one is kept. Nothing is deleted.`
}

export function deleteQuestion(w: Watcher): string {
    const name = w.name
    return t`Delete ${name}? The two folders and their files stay as they are, they just stop syncing with each other.`
}

export function searchFields(w: Watcher): string[] {
    return [w.name, w.pathA, w.pathB]
}

/** The line under the window's title. */
export function summaryOf(watchers: readonly Watcher[]): string {
    const paused = watchers.filter((w) => w.paused).length
    const watching = watchers.length - paused
    const attention = watchers.filter((w) => w.attention && !w.resyncing).length
    const parts = [
        paused > 0
            ? t({
                  message: plural(paused, {
                      one: `${watching} watching, # paused.`,
                      other: `${watching} watching, # paused.`,
                  }),
                  comment: 'How many watchers run, and how many are paused.',
              })
            : t({
                  message: plural(watching, { one: '# watching.', other: '# watching.' }),
                  comment: 'How many watchers run.',
              }),
    ]
    if (attention > 0) {
        parts.push(
            t({
                message: plural(attention, { one: '# needs you.', other: '# need you.' }),
                comment: 'How many watchers need the user to look at them.',
            })
        )
    }
    return parts.join(' ')
}
