import { browse, files, transfers } from '../../../lib/core/api'
import type { Files } from '../../../lib/core/types'
import { coreError } from '../../../lib/errors'
import { onLive, onResync } from '../../../lib/live'
import { entryChanged } from './listing'

export type RenameItem = Files.RenameItem

export interface Flash {
    transferId?: string
}

export async function makeFolder(path: string): Promise<void> {
    await files.Mkdir(path)
    entryChanged(path, true)
}

export async function renameEntry(item: RenameItem): Promise<Flash> {
    const res = await files.Rename(item.path, item.isDir, item.newName)
    if (!res.transferId) entryChanged(item.path, item.isDir)
    return { transferId: res.transferId || undefined }
}

export async function deleteEntry(path: string, isDir: boolean): Promise<Flash> {
    const { id } = await files.Delete(path, isDir)
    if (!id) entryChanged(path, isDir)
    return { transferId: id || undefined }
}

export async function batchRename(items: RenameItem[]): Promise<string> {
    const { id } = await files.BatchRename(items)
    return id
}

export async function publicLink(path: string): Promise<string | undefined> {
    const url = await browse.PublicLink(path)
    return url || undefined
}

export const ELSEWHERE = 'elsewhere'

const ends = new Map<string, string>()
const KEPT_ENDS = 200
const waiting = new Map<string, Set<(state: string) => void>>()

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

onResync(() => {
    for (const id of waiting.keys()) {
        transfers.Get(id).then(
            (detail) => ended(id, detail.transfer.state),
            (error) => {
                if (coreError(error)?.code === 'not_found') ended(id, ELSEWHERE)
            }
        )
    }
})

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
