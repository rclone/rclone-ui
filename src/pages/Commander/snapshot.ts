import type { PanelRestore } from '../../components/navigator/FilePanel'
import type { SelectItem, Sort } from '../../components/navigator/types'
import { BY_NAME } from '../../components/navigator/utils'

export interface Place {
    remote: string
    path: string
}

export interface PanelSnapshot {
    place: Place
    sort: Sort
    selection: SelectItem[]
    scrollTop: number
}

export interface CommanderSnapshot {
    left?: PanelSnapshot
    right?: PanelSnapshot
    tracked: string[]
    barOpen: boolean
}

export const TRACKED_MAX = 20

export const SELECTION_MAX = 1_000

const EMPTY: CommanderSnapshot = { tracked: [], barOpen: false }

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const SORT_COLUMNS = new Set(['name', 'size', 'modTime'])
const SORT_DIRECTIONS = new Set(['ascending', 'descending'])

function readSort(value: unknown): Sort {
    if (!isObject(value)) return BY_NAME
    const { column, direction } = value
    return SORT_COLUMNS.has(column as string) && SORT_DIRECTIONS.has(direction as string)
        ? ({ column, direction } as Sort)
        : BY_NAME
}

function readSelection(value: unknown): SelectItem[] {
    if (!Array.isArray(value)) return []
    return value.filter(
        (item): item is SelectItem =>
            isObject(item) &&
            typeof item.path === 'string' &&
            item.path !== '' &&
            (item.type === 'file' || item.type === 'folder')
    )
}

function readPlace(value: unknown): Place | undefined {
    if (!isObject(value) || typeof value.remote !== 'string' || value.remote === '') return
    if (typeof value.path !== 'string') return
    if (value.remote === 'UI_FAVORITES') return { remote: value.remote, path: '' }
    return { remote: value.remote, path: value.path }
}

function readPanel(value: unknown): PanelSnapshot | undefined {
    if (!isObject(value)) return
    const place = readPlace(value.place)
    if (!place) return
    const scrollTop = Number(value.scrollTop)
    return {
        place,
        sort: readSort(value.sort),
        selection: readSelection(value.selection),
        scrollTop: Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0,
    }
}

export function readSnapshot(stored: unknown): CommanderSnapshot {
    if (!isObject(stored)) return EMPTY
    const tracked = Array.isArray(stored.tracked)
        ? stored.tracked.filter((id): id is string => typeof id === 'string' && id !== '')
        : []
    return {
        left: readPanel(stored.left),
        right: readPanel(stored.right),
        tracked: tracked.slice(-TRACKED_MAX),
        barOpen: stored.barOpen === true,
    }
}

export function snapshotKey(dataDir: string): string {
    return `commander:${dataDir}`
}

export function loadSnapshot(key: string, storage: Storage | undefined = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(key)
        return raw ? readSnapshot(JSON.parse(raw)) : EMPTY
    } catch {
        return EMPTY
    }
}

export function saveSnapshot(
    key: string,
    snapshot: CommanderSnapshot,
    storage: Storage | undefined = globalThis.localStorage
) {
    const kept: CommanderSnapshot = {
        ...snapshot,
        left: keptPanel(snapshot.left),
        right: keptPanel(snapshot.right),
        tracked: snapshot.tracked.slice(-TRACKED_MAX),
    }
    try {
        storage?.setItem(key, JSON.stringify(kept))
    } catch {}
}

function keptPanel(panel: PanelSnapshot | undefined): PanelSnapshot | undefined {
    return panel && panel.selection.length > SELECTION_MAX ? { ...panel, selection: [] } : panel
}

export interface PanelOpening {
    place?: Place
    restore?: PanelRestore
}

export const samePlace = (a: Place, b: Place) => a.remote === b.remote && a.path === b.path

export function scrollAfterMove(was: Place | undefined, now: Place, scrollTop: number): number {
    return !was || samePlace(was, now) ? scrollTop : 0
}

export function openingOf(
    route: Place | undefined,
    snapshot: PanelSnapshot | undefined
): PanelOpening {
    const place = route ?? snapshot?.place
    if (!place) return {}
    if (!snapshot || !samePlace(snapshot.place, place)) return { place }
    const { sort, selection, scrollTop } = snapshot
    return { place, restore: { sort, selection, scrollTop } }
}
