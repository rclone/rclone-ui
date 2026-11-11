import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { prefs } from './core/api'
import { coreKey } from './core/query'

/** Every stored preference, as a JSON string by key. */
type Values = { [key: string]: string | undefined }

/** The query for every preference. One query serves the whole window. */
const prefsQuery = {
    queryKey: coreKey('prefs', 'Get'),
    queryFn: (): Promise<Values> => prefs.Get([]),
}

/** Every preference key the pages use, with its default. */
export const PREF_DEFAULTS = {
    /** The app's theme, which either follows the system or is set to light or dark. */
    theme: 'dark' as 'light' | 'dark' | 'system',
    /**
     * The one-time things already done on this machine, so they don't happen again: the
     * launcher-shortcut tip on the tray's Open (app/trayopen.go), Commander's activity tip
     * (TransfersBar) and enabling the launcher's GNOME extension
     * (app/launcher/view/linux/gnome/ensure_linux.go).
     */
    acknowledgements: [] as string[],
    /** Local disks and folders that are hidden from Places in the file panels. */
    hiddenLocalPaths: [] as string[],
    /** Whether the file panels measure local folder sizes while they list them. */
    folderSizes: true as boolean,
    /**
     * Whether the file panels read the files' dates on S3, Swift and the other remotes where each
     * date costs a request (see fileDates.ts).
     */
    fileDates: false as boolean,
    /**
     * The folder that the last pick for a source was made in. An empty source field's picker
     * opens there (see pickerMemory.ts). Empty until a source is picked.
     */
    lastSourceFolder: '' as string,
    /** The same for a destination: where an empty destination field's picker opens. */
    lastDestinationFolder: '' as string,
}

export type PrefKey = keyof typeof PREF_DEFAULTS

/**
 * Returns one preference and its setter. The value is the stored JSON, or the default. Setting a
 * value updates the page at once and then the core, and prefs.changed brings every window up to
 * date. If the core refuses the value, the old value is restored and the setter rejects, so that
 * the caller can report the error.
 */
export function usePref<K extends PrefKey>(
    key: K
): [(typeof PREF_DEFAULTS)[K], (v: (typeof PREF_DEFAULTS)[K]) => Promise<void>] {
    const queryClient = useQueryClient()
    const query = useQuery(prefsQuery)
    const value = useMemo(() => {
        const raw = query.data?.[key]
        if (raw === undefined) return PREF_DEFAULTS[key]
        try {
            return JSON.parse(raw) as (typeof PREF_DEFAULTS)[K]
        } catch {
            return PREF_DEFAULTS[key]
        }
    }, [query.data, key])

    const set = useCallback(
        async (v: (typeof PREF_DEFAULTS)[K]) => {
            const { queryKey } = prefsQuery
            // Cancel any read in flight, because it would return the value from before this set.
            await queryClient.cancelQueries({ queryKey })
            const before = queryClient.getQueryData<Values>(queryKey)?.[key]
            const write = (raw: string | undefined) =>
                queryClient.setQueryData(queryKey, (old: Values | undefined) => {
                    if (!old) return old
                    const values = Object.fromEntries(
                        Object.entries(old).filter(([k]) => k !== key)
                    )
                    if (raw !== undefined) values[key] = raw
                    return values
                })
            const raw = JSON.stringify(v)
            write(raw)
            try {
                await prefs.Set(key, raw)
            } catch (error) {
                // Restore only this key, so that a change to another key in the meantime is kept.
                write(before)
                throw error
            }
        },
        [queryClient, key]
    )

    return [value, set]
}

/** Whether this machine's preferences have been read. Until then, `usePref` returns defaults. */
export function usePrefsLoaded(): boolean {
    return useQuery(prefsQuery).isSuccess
}
