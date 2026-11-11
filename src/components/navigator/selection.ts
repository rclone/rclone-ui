// The rules for a panel's selection when folders and what is inside them could both be ticked.
// A selected folder already includes everything inside it, so ticking an item inside it would
// send that item twice. Such a tick is refused, and selecting a folder unticks what is inside it.

import { t } from '@lingui/core/macro'
import { baseName, currentHost, type Host } from '../../../lib/paths'
import { isInside } from './drops'

/** A panel's selection: each path, in the order it was picked, with its type. */
export type Selection = Map<string, 'file' | 'folder'>

type Item = { key: string; isDir: boolean }

export function folderHolding(
    selection: Selection,
    key: string,
    host: Host = currentHost()
): string | undefined {
    for (const [path, type] of selection) {
        if (type === 'folder' && isInside(key, path, host)) return path
    }
    return undefined
}

/** Adds an item to the selection. A folder replaces whatever was selected inside it. */
export function addTo(selection: Selection, item: Item, host: Host = currentHost()) {
    if (item.isDir) {
        for (const path of [...selection.keys()]) {
            if (isInside(path, item.key, host)) selection.delete(path)
        }
    }
    selection.set(item.key, item.isDir ? 'folder' : 'file')
}

/** Removes an item from the selection, with anything selected inside it. */
export function removeFrom(selection: Selection, key: string, host: Host = currentHost()) {
    selection.delete(key)
    for (const path of [...selection.keys()]) {
        if (isInside(path, key, host)) selection.delete(path)
    }
}

/**
 * Selects `items`, except those inside a folder that is selected or being selected. Returns the
 * new selection, and the folder that already held a skipped item, for the toast.
 */
export function selectAllOf(
    selection: Selection,
    items: readonly Item[],
    host: Host = currentHost()
): { next: Selection; holder: string | undefined } {
    const next = new Map(selection)
    let holder: string | undefined
    // Folders first, so an item that comes before its folder in the list is still skipped.
    const ordered = [...items.filter((item) => item.isDir), ...items.filter((item) => !item.isDir)]
    for (const item of ordered) {
        if (next.has(item.key)) continue
        const before = folderHolding(selection, item.key, host)
        if (before) {
            holder ??= before
            continue
        }
        if (folderHolding(next, item.key, host)) continue
        addTo(next, item, host)
    }
    return { next, holder }
}

/** The toast that explains why an item inside a selected folder can't be ticked. */
export function alreadySelected(folder: string, host: Host = currentHost()) {
    const name = baseName(folder, host) || folder
    return {
        title: t`Already selected`,
        description: t`“${name}” is selected, so its contents are included already. Unselect it to choose items inside it.`,
    }
}
