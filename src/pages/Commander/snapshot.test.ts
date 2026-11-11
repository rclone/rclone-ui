import { expect, test } from 'vitest'
import {
    type CommanderSnapshot,
    loadSnapshot,
    openingOf,
    type PanelSnapshot,
    readSnapshot,
    SELECTION_MAX,
    saveSnapshot,
    scrollAfterMove,
    snapshotKey,
    TRACKED_MAX,
} from './snapshot'

function memoryStorage(): Storage {
    const values = new Map<string, string>()
    return {
        get length() {
            return values.size
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => {
            values.delete(key)
        },
        setItem: (key, value) => {
            values.set(key, value)
        },
    }
}

const photos: PanelSnapshot = {
    place: { remote: 'gdrive', path: 'photos' },
    sort: { column: 'size', direction: 'descending' },
    selection: [{ path: 'gdrive:photos/a.jpg', type: 'file' }],
    scrollTop: 500,
}

test('the route’s place wins, and the rest comes back only for the same place', () => {
    // No route place: the panel opens where it was left, as it was left.
    expect(openingOf(undefined, photos)).toEqual({
        place: photos.place,
        restore: { sort: photos.sort, selection: photos.selection, scrollTop: 500 },
    })
    // The route names the same place: the panel takes back its sort, selection and scroll.
    expect(openingOf({ remote: 'gdrive', path: 'photos' }, photos).restore?.scrollTop).toBe(500)
    // The route names another place: it opens there, fresh.
    expect(openingOf({ remote: 'gdrive', path: 'docs' }, photos)).toEqual({
        place: { remote: 'gdrive', path: 'docs' },
    })
    expect(openingOf({ remote: 'UI_LOCAL_FS', path: '/tmp' }, undefined)).toEqual({
        place: { remote: 'UI_LOCAL_FS', path: '/tmp' },
    })
    // Neither: the panel opens at its default place.
    expect(openingOf(undefined, undefined)).toEqual({})
})

test('a panel left on Favorites or the list of local disks reopens there', () => {
    const storage = memoryStorage()
    const key = snapshotKey('/data')
    const at = (remote: string, path: string): PanelSnapshot => ({
        place: { remote, path },
        sort: { column: 'name', direction: 'ascending' },
        selection: [],
        scrollTop: 0,
    })
    saveSnapshot(
        key,
        {
            left: at('UI_FAVORITES', ''),
            right: at('UI_LOCAL_FS', ''),
            tracked: [],
            barOpen: false,
        },
        storage
    )
    const back = loadSnapshot(key, storage)
    expect(openingOf(undefined, back.left).place).toEqual({ remote: 'UI_FAVORITES', path: '' })
    expect(openingOf(undefined, back.right).place).toEqual({ remote: 'UI_LOCAL_FS', path: '' })
})

test('each data folder keeps its own snapshot', () => {
    const storage = memoryStorage()
    const snapshot: CommanderSnapshot = { left: photos, tracked: ['t1'], barOpen: true }
    saveSnapshot(snapshotKey('/a'), snapshot, storage)
    expect(loadSnapshot(snapshotKey('/a'), storage)).toEqual({ ...snapshot, right: undefined })
    expect(loadSnapshot(snapshotKey('/b'), storage)).toEqual({ tracked: [], barOpen: false })
})

test('a large selection isn’t kept, and only the last transfers are', () => {
    const storage = memoryStorage()
    const many = Array.from({ length: SELECTION_MAX + 1 }, (_, i) => ({
        path: `gdrive:photos/${i}`,
        type: 'file' as const,
    }))
    const ids = Array.from({ length: TRACKED_MAX + 5 }, (_, i) => `t${i}`)
    saveSnapshot(
        'k',
        { left: { ...photos, selection: many }, right: photos, tracked: ids, barOpen: false },
        storage
    )
    const back = loadSnapshot('k', storage)
    expect(back.left?.selection).toEqual([])
    expect(back.left?.scrollTop).toBe(500)
    expect(back.right?.selection).toEqual(photos.selection)
    expect(back.tracked).toEqual(ids.slice(-TRACKED_MAX))
})

test('bad stored data is fixed on read', () => {
    expect(readSnapshot(null)).toEqual({ tracked: [], barOpen: false })
    expect(readSnapshot('nope')).toEqual({ tracked: [], barOpen: false })
    const read = readSnapshot({
        left: {
            place: { remote: 'gdrive', path: 'x' },
            sort: { column: 'colour', direction: 'up' },
            selection: [{ path: 'gdrive:x/a', type: 'file' }, { path: '' }, 'b', null],
            scrollTop: 'far',
        },
        right: { place: { remote: '', path: '/' } },
        tracked: ['a', 1, '', 'b'],
        barOpen: 'yes',
    })
    expect(read).toEqual({
        left: {
            place: { remote: 'gdrive', path: 'x' },
            sort: { column: 'name', direction: 'ascending' },
            selection: [{ path: 'gdrive:x/a', type: 'file' }],
            scrollTop: 0,
        },
        right: undefined,
        tracked: ['a', 'b'],
        barOpen: false,
    })
    // Text that isn't JSON starts fresh.
    const storage = memoryStorage()
    storage.setItem('k', '{')
    expect(loadSnapshot('k', storage)).toEqual({ tracked: [], barOpen: false })
})

test('the scroll position resets when a panel changes folder', () => {
    const photosPlace = { remote: 'gdrive', path: 'photos' }
    // The panel's first report is where it was restored, so the scroll stays.
    expect(scrollAfterMove(undefined, photosPlace, 500)).toBe(500)
    expect(scrollAfterMove(photosPlace, { ...photosPlace }, 500)).toBe(500)
    expect(scrollAfterMove(photosPlace, { remote: 'gdrive', path: 'photos/2024' }, 500)).toBe(0)
    expect(scrollAfterMove(photosPlace, { remote: 'other', path: 'photos' }, 500)).toBe(0)
})
