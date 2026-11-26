import { useCallback } from 'react'
import { currentHost, type Host, parsePath } from '../../lib/paths'
import { usePref } from '../../lib/prefs'
import { parentListingOf } from './navigator/listingKey'
import type { AllowedKey, SelectItem } from './navigator/types'
import { panelFolder } from './navigator/utils'

export type PlaceKind = 'source' | 'destination'

const PREF = { source: 'lastSourceFolder', destination: 'lastDestinationFolder' } as const

export function placeToRemember(
    items: SelectItem[],
    shown: string | null,
    host: Host = currentHost()
): string | undefined {
    const first = items[0]
    if (!first) return undefined
    if (shown) return shown
    const { remote, dir } = parentListingOf(first.path, host)
    return panelFolder(remote, dir) ?? undefined
}

export function rememberedStart(
    place: string,
    allowedKeys: AllowedKey[] | undefined,
    host: Host = currentHost()
): string | undefined {
    if (!place) return undefined
    if (!allowedKeys) return place
    const needs = parsePath(place, host).kind === 'remote' ? 'REMOTES' : 'LOCAL_FS'
    return allowedKeys.includes(needs) ? place : undefined
}

export function usePickerMemory(
    kind: PlaceKind | undefined,
    allowedKeys: AllowedKey[] | undefined
): { start: string | undefined; remember: (items: SelectItem[], shown: string | null) => void } {
    const [place, setPlace] = usePref(PREF[kind ?? 'source'])
    const start = kind ? rememberedStart(place, allowedKeys) : undefined
    const remember = useCallback(
        (items: SelectItem[], shown: string | null) => {
            if (!kind) return
            const next = placeToRemember(items, shown)
            if (!next || next === place) return
            setPlace(next).catch((error: unknown) =>
                console.warn('could not remember the folder of the pick', error)
            )
        },
        [kind, place, setPlace]
    )
    return { start, remember }
}
