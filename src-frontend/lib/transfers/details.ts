import type { TransferDetail, TransferredFile } from '../api/transfers'
import { inputLabel } from './retry'

// What the transfer drawer shows of the files that are done, and which errors go at its top.
// Pure, so the node-side spec runs it as it is.

/** The files that are done, by how they ended: each section of the drawer holds one kind. */
export function splitFiles(
    files: TransferredFile[] | null | undefined,
    /** Failures gathered while it ran (`detail.failed`): they outlast rclone's last hundred. */
    collected?: TransferredFile[]
) {
    const all = files ?? []
    return {
        transferred: all.filter((file) => !file.error),
        failed: collected ?? all.filter((file) => !!file.error),
    }
}

export interface GeneralError {
    /** What it was about: the input it came from, or null for the transfer as a whole. */
    subject: string | null
    error: string
}

/**
 * The errors that belong to no file. rclone reports a folder's error (and a sync's) as the last
 * error it met, which is nearly always a file's, word for word, and that file's row already
 * says it. What is left is what has no row: an input that never became a file, a folder that
 * could not be read, a transfer that never got going.
 *
 * Only an exact match counts as "already shown": a miss repeats an error, it never hides one.
 */
export function generalErrors({
    status,
    recorded,
    failed,
}: {
    /** rclone's last word on the job; absent when it never gave one. */
    status: TransferDetail['status']
    /** The record's own error. Beside a status it is a summary of it, and is not repeated. */
    recorded: string | null
    failed: TransferredFile[]
}): GeneralError[] {
    if (!status) return recorded ? [{ subject: null, error: recorded }] : []
    const shown = new Set(failed.map((file) => file.error))
    const results = status.output?.results ?? []
    return [
        ...(status.error ? [{ subject: null, error: status.error }] : []),
        ...results.flatMap((result) =>
            result.error
                ? [{ subject: result.input ? inputLabel(result.input) : null, error: result.error }]
                : []
        ),
    ].filter((general) => !shown.has(general.error))
}
