import { useCallback, useMemo, useState } from 'react'
import { foldCase } from '../../../lib/format'

export const SEARCH_FROM = 5

export function matchAny<T>(items: readonly T[], search: string, fields: (t: T) => string[]): T[] {
    const text = foldCase(search.trim())
    if (!text) return [...items]
    return items.filter((item) => fields(item).some((field) => foldCase(field).includes(text)))
}

export function useListSearch<T>(items: readonly T[], fields: (t: T) => string[]) {
    const [search, setSearch] = useState('')
    const searching = items.length > SEARCH_FROM
    const shown = useMemo(
        () => (searching ? matchAny(items, search, fields) : items),
        [items, search, searching, fields]
    )
    return { search, setSearch, searching, shown }
}

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
