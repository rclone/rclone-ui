// The filesystem changes made by the Commander and the pickers. Each one is a call to the core
// (files or browse), which checks and runs it. A name clash comes back as an error for the field.
// Renaming or deleting a folder, and a batch rename, start a recorded transfer, and the call
// returns it. The core publishes files.changed, and the panels that show an affected folder
// list it again. The page that made the change also announces it right away.

import { browse, files, transfers } from '../../../lib/core/api'
import type { Files } from '../../../lib/core/types'
import { coreError } from '../../../lib/errors'
import { onLive, onResync } from '../../../lib/live'
import { entryChanged } from './listing'

/** Renames an entry within its folder. */
export type RenameItem = Files.RenameItem

/** The result of an action: the transfer it started, if any. */
export interface Flash {
    transferId?: string
}

/**
 * Creates a folder at `path` (a full path). On a backend that can't hold empty folders, the core
 * writes a `.empty` file into it.
 */
export async function makeFolder(path: string): Promise<void> {
    await files.Mkdir(path)
    entryChanged(path, true)
}

/**
 * Renames an entry in place. The rename is refused when something already has the new name. A
 * file is renamed immediately. A folder is moved by a recorded transfer (`transferId`), and the
 * panels refresh when it ends (`transfers.changed`).
 */
export async function renameEntry(item: RenameItem): Promise<Flash> {
    const res = await files.Rename(item.path, item.isDir, item.newName)
    if (!res.transferId) entryChanged(item.path, item.isDir)
    return { transferId: res.transferId || undefined }
}

/** Deletes an entry. A file is deleted immediately, and a folder by a recorded transfer. */
export async function deleteEntry(path: string, isDir: boolean): Promise<Flash> {
    const { id } = await files.Delete(path, isDir)
    if (!id) entryChanged(path, isDir)
    return { transferId: id || undefined }
}

/** Starts the batch rename plan as one recorded transfer and returns its id. */
export async function batchRename(items: RenameItem[]): Promise<string> {
    const { id } = await files.BatchRename(items)
    return id
}

/** Returns a public link to the entry, when its backend supports them. */
export async function publicLink(path: string): Promise<string | undefined> {
    const url = await browse.PublicLink(path)
    return url || undefined
}

/**
 * The state passed to a waiting handler when the core has no record of the transfer. Nothing
 * will report how it ends, so the handler stops waiting.
 */
export const ELSEWHERE = 'elsewhere'

/** The final state of recent transfers (`completed`, `failed`, `stopped`, `interrupted`), by id. */
const ends = new Map<string, string>()
const KEPT_ENDS = 200
const waiting = new Map<string, Set<(state: string) => void>>()

/**
 * Tells the handlers waiting for transfer `id` that it ended in `state`, and remembers the state.
 * ELSEWHERE isn't remembered, because it isn't a real end.
 */
function ended(id: string, state: string) {
    if (state === 'queued' || state === 'running') return
    if (state !== ELSEWHERE) {
        ends.set(id, state)
        if (ends.size > KEPT_ENDS) ends.delete(ends.keys().next().value as string)
    }
    const handlers = waiting.get(id)
    waiting.delete(id)
    for (const handler of handlers ?? []) handler(state)
}

onLive('transfers.changed', ({ id, state }) => ended(id, state))

// Missed events aren't replayed, so after a resync, read the state of each awaited transfer
// directly.
onResync(() => {
    for (const id of waiting.keys()) {
        transfers.Get(id).then(
            (detail) => ended(id, detail.transfer.state),
            (error) => {
                // The core has no such transfer. After any other error, try again at the next
                // resync.
                if (coreError(error)?.code === 'not_found') ended(id, ELSEWHERE)
            }
        )
    }
})

/**
 * Calls `handler` with the final state of transfer `id` when it ends, or immediately if it has
 * already ended. The core starts the transfer during the call, so a short transfer can end before
 * the call returns its id, and the end event isn't replayed. If the core turns out to have no
 * such transfer, the handler gets ELSEWHERE. Returns a function that unsubscribes.
 */
export function onTransferEnd(id: string, handler: (state: string) => void): () => void {
    const ended = ends.get(id)
    if (ended !== undefined) {
        handler(ended)
        return () => undefined
    }
    let handlers = waiting.get(id)
    if (!handlers) {
        handlers = new Set()
        waiting.set(id, handlers)
    }
    const own = handlers
    own.add(handler)
    return () => {
        own.delete(handler)
        if (own.size === 0 && waiting.get(id) === own) waiting.delete(id)
    }
}
