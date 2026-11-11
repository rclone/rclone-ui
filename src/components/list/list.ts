import { useCallback, useMemo, useState } from 'react'
import { foldCase } from '../../../lib/format'

/**
 * A list shows its search field once it holds more than this many things. A shorter list is easy
 * to scan.
 */
export const SEARCH_FROM = 5

export function matchAny<T>(items: readonly T[], search: string, fields: (t: T) => string[]): T[] {
    const text = foldCase(search.trim())
    if (!text) return [...items]
    return items.filter((item) => fields(item).some((field) => foldCase(field).includes(text)))
}

/**
 * The search of a list. `searching` says whether the list is long enough to show the field
 * (SEARCH_FROM), and `shown` is what the list shows: the items that match the search, or every
 * item while there is no field. `fields` should be the same function on every render, such as a
 * status.ts `searchFields`.
 */
export function useListSearch<T>(items: readonly T[], fields: (t: T) => string[]) {
    const [search, setSearch] = useState('')
    const searching = items.length > SEARCH_FROM
    const shown = useMemo(
        () => (searching ? matchAny(items, search, fields) : items),
        [items, search, searching, fields]
    )
    return { search, setSearch, searching, shown }
}

/**
 * The drawer of a list window, which makes a new thing (no item) or edits one. The key changes at
 * each opening, so that the drawer starts with fresh fields. Closing keeps the item, so that the
 * drawer still shows it while it slides away.
 */
export function useDrawer<T>(initial?: { item?: T; open?: boolean }) {
    const [drawer, setDrawer] = useState<{ isOpen: boolean; item?: T; key: number }>(() => ({
        isOpen: initial?.open ?? false,
        item: initial?.item,
        key: 0,
    }))
    const open = useCallback(
        (item?: T) => setDrawer((d) => ({ isOpen: true, item, key: d.key + 1 })),
        []
    )
    const close = useCallback(() => setDrawer((d) => ({ ...d, isOpen: false })), [])
    return { drawer, open, close }
}
