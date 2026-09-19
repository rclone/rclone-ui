import type { TransferDetail, TransferredFile } from '../api/transfers'

// What of an ended transfer can be retried, and the request that retries a selection of it.
// Pure, so the node-side spec runs it as it is. Everything is derived from two things the server
// keeps with a transfer: the request it was started with, and the files that failed while it ran.

type BatchInput = { _path: string } & Record<string, unknown>

export interface RetryItem {
    /** Stable within one transfer: what a selection is made of. */
    key: string
    /** A file that failed inside a folder, or an input that failed as a whole. */
    kind: 'file' | 'input'
    /** What the list shows: the file's path within its folder, or what the input named. */
    label: string
    /** The full source path, for the record of the transfer that retries it. */
    source: string
    error: string
    /** The batch input that retries it. */
    input: BatchInput
}

const FOLDER_PATHS: Record<string, string> = {
    'sync/copy': 'operations/copyfile',
    'sync/move': 'operations/movefile',
}

/**
 * An fs as something comparable. rclone gives a file's `srcFs` back in its canonical form:
 * trailing separators gone, and a remote that was given options (`gdrive,chunk_size=8M:`) named
 * by a hash of them (`gdrive{AbCdE}:`). Both reduce to the remote's bare name and its root.
 */
export function fsKey(fs: string): string {
    const trimmed = (path: string) => (path.length > 1 ? path.replace(/[/\\]+$/, '') : path)
    // A path, a drive letter included: no remote to reduce.
    if (/^([/\\.~]|[a-zA-Z]:[/\\])/.test(fs)) return trimmed(fs)
    let quote: string | null = null
    for (let at = 1; at < fs.length; at++) {
        const char = fs[at]
        if (quote) {
            if (char === quote) quote = null
        } else if (char === '"' || char === "'") {
            quote = char
        } else if (char === ':') {
            const name = fs.slice(0, at).split(/[,{]/)[0]
            return `${name}:${trimmed(fs.slice(at + 1))}`
        }
    }
    return trimmed(fs)
}

function joinFs(fs: string, remote: string | undefined) {
    if (!remote) return fs
    return fs.endsWith(':') || fs.endsWith('/') || fs.endsWith('\\')
        ? `${fs}${remote}`
        : `${fs}/${remote}`
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

/** A failed file that was a transfer: not a delete, not a check, not something skipped. */
function isFailedTransfer(file: TransferredFile) {
    return (
        !!file.error &&
        !!file.name &&
        !file.checked &&
        (!file.what || file.what === 'transferring' || file.what === 'moving')
    )
}

const byName = (files: TransferredFile[]) =>
    [...files].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))

function fileItem(index: number, file: TransferredFile, path: string, ends: BatchInput): RetryItem {
    const srcFs = text(ends.srcFs) ?? ''
    return {
        key: `file:${index}:${file.name}`,
        kind: 'file',
        label: file.name!,
        source: joinFs(srcFs, file.name),
        error: file.error!,
        // The folder's ends and config. No `_filter`: a named file needs none, and one that
        // excluded it would make the retry do nothing.
        input: {
            _path: path,
            srcFs,
            srcRemote: file.name,
            dstFs: ends.dstFs,
            dstRemote: file.name,
            ...(ends._config ? { _config: ends._config } : {}),
        },
    }
}

/** An input by what it names: its file, or for a folder, which has none, where it is read from. */
export function inputLabel(input: Record<string, unknown>) {
    return text(input.srcRemote) ?? text(input.remote) ?? text(input.srcFs) ?? text(input.fs) ?? ''
}

function inputItem(index: number, input: BatchInput, error: string): RetryItem {
    const fs = text(input.srcFs) ?? text(input.fs) ?? ''
    const remote = text(input.srcRemote) ?? text(input.remote)
    return {
        key: `input:${index}`,
        kind: 'input',
        label: inputLabel(input),
        source: joinFs(fs, remote),
        error,
        input,
    }
}

/**
 * What went wrong, without the run-up. rclone's errors lead with the paths involved (which the
 * row already shows) and end with the reason, so a line clamped to fit has to spend its room on
 * the end. The whole text stays available on hover.
 */
export function errorReason(error: string): string {
    const reason = error.split(': ').pop()?.trim()
    return reason || error.trim()
}

/**
 * Everything of a transfer that can be retried: its inputs in the order they were asked for,
 * the failed files of a folder by name (rclone lists them in the order they finished, which
 * helps nobody find one among many).
 */
export function retryPlan(detail: TransferDetail | null | undefined): RetryItem[] {
    const request = detail?.request
    if (!request) return []
    // Failures collected while it ran.
    const failed = (detail.failed ?? []).filter(isFailedTransfer)

    if (request.endpoint === '/sync/sync') {
        // Its failed files are copied. The sync itself is never re-run narrowed to them: with
        // `delete_excluded` that would delete everything else at the destination.
        const ends = { _path: 'sync/sync', ...request.body } as BatchInput
        return byName(failed).map((file) => fileItem(0, file, 'operations/copyfile', ends))
    }
    if (request.endpoint !== '/job/batch') return []

    const inputs = (request.body.inputs ?? []) as BatchInput[]
    // One result per input, in order. None at all (a stopped transfer): any folder may have
    // been the one a file failed in, and no input is known to have failed as a whole.
    const results = detail.status?.output?.results
    const errorOf = (index: number) => results?.[index]?.error || undefined
    const folders = inputs
        .map((input, index) => ({ input, index }))
        .filter(({ input, index }) => input._path in FOLDER_PATHS && (!results || errorOf(index)))

    const filesOf = new Map<number, TransferredFile[]>()
    for (const file of failed) {
        const home =
            folders.find(
                ({ input }) =>
                    (!!file.srcFs && fsKey(text(input.srcFs) ?? '') === fsKey(file.srcFs)) ||
                    (!!file.dstFs && fsKey(text(input.dstFs) ?? '') === fsKey(file.dstFs))
            ) ??
            // One folder is every file's folder. With several and no match it is not guessed.
            (folders.length === 1 ? folders[0] : undefined)
        if (home) filesOf.set(home.index, [...(filesOf.get(home.index) ?? []), file])
    }

    return inputs.flatMap((input, index) => {
        const files = filesOf.get(index)
        if (files) {
            return byName(files).map((file) =>
                fileItem(index, file, FOLDER_PATHS[input._path], input)
            )
        }
        // Failed as a whole — a file that was not there, a folder that never got going or whose
        // failures fell out of rclone's window: retried as it was. For a folder that is a
        // re-run, and rclone skips what already arrived.
        const error = errorOf(index)
        return error ? [inputItem(index, input, error)] : []
    })
}

/** One batch of a selection, the config repeated at its top as the builders do. */
export function retryRequest(items: RetryItem[], detail: TransferDetail) {
    const config = detail.request?.body._config
    return {
        endpoint: '/job/batch' as const,
        body: {
            inputs: items.map((item) => item.input),
            ...(config ? { _config: config } : {}),
            _async: true,
        },
    }
}

/** What running the whole operation again does about work that already went through. */
export function rerunEffect(operation: string) {
    if (operation === 'move') return 'Files that already moved are no longer at the source.'
    if (operation === 'delete' || operation === 'purge') {
        return 'What was already deleted is not there to fail twice.'
    }
    return 'Files that already arrived are skipped.'
}
