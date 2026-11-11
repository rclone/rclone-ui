// Picker memory. A path field that an operation reads from (a source) or writes to (a destination)
// opens its picker, while the field is empty, in the folder that the last pick for that kind of
// field was made in. A field that holds a path opens at that path instead. The two folders are
// preferences, so every window shares them and they are kept across restarts. Which fields
// remember, and as which kind, is in operation/places.ts. The Serve and Mount pages set up their
// pickers themselves, so they pass `remember` on the field.

import { useCallback } from 'react'
import { currentHost, type Host, parsePath } from '../../lib/paths'
import { usePref } from '../../lib/prefs'
import { parentListingOf } from './navigator/listingKey'
import type { AllowedKey, SelectItem } from './navigator/types'
import { panelFolder } from './navigator/utils'

export type PlaceKind = 'source' | 'destination'

const PREF = { source: 'lastSourceFolder', destination: 'lastDestinationFolder' } as const

/**
 * The folder to remember for a pick: the one the picker showed, not a picked folder itself, so
 * that the next picker opens beside the last pick, with its neighbours in view. Favorites and the
 * list of disks aren't folders (`shown` is null), so a pick there remembers the folder that the
 * first item is in. Undefined when nothing was picked, or for a bare local name, which is in no
 * folder.
 */
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

/**
 * The remembered folder, if the picker offers that kind of place. Undefined otherwise, and then
 * the picker opens as it does with nothing remembered. Without this, a local folder that a copy's
 * source left would open a delete's picker, which offers only remotes, on this computer.
 */
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

/**
 * A field's picker memory: `start`, the folder that the picker opens at while the field is empty,
 * and `remember`, which saves the folder of a confirmed pick. A field with no kind neither opens
 * at a remembered folder nor saves one. If the folder is gone (its remote was deleted), the panel
 * shows the error that it shows for any bad path, and the sidebar still works.
 */
export function usePickerMemory(
    kind: PlaceKind | undefined,
    allowedKeys: AllowedKey[] | undefined
): { start: string | undefined; remember: (items: SelectItem[], shown: string | null) => void } {
    // A hook can't be skipped, so a field with no kind reads the sources' folder and ignores it.
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
