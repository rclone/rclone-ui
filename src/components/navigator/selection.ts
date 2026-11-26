import { t } from '@lingui/core/macro'
import { baseName, currentHost, type Host } from '../../../lib/paths'
import { isInside } from './drops'

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

export function addTo(selection: Selection, item: Item, host: Host = currentHost()) {
    if (item.isDir) {
        for (const path of [...selection.keys()]) {
            if (isInside(path, item.key, host)) selection.delete(path)
        }
    }
    selection.set(item.key, item.isDir ? 'folder' : 'file')
}

export function removeFrom(selection: Selection, key: string, host: Host = currentHost()) {
    selection.delete(key)
    for (const path of [...selection.keys()]) {
        if (isInside(path, key, host)) selection.delete(path)
    }
}

export function selectAllOf(
    selection: Selection,
    items: readonly Item[],
    host: Host = currentHost()
): { next: Selection; holder: string | undefined } {
    const next = new Map(selection)
    let holder: string | undefined
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

export function alreadySelected(folder: string, host: Host = currentHost()) {
    const name = baseName(folder, host) || folder
    return {
        title: t`Already selected`,
        description: t`“${name}” is selected, so its contents are included already. Unselect it to choose items inside it.`,
    }
}
