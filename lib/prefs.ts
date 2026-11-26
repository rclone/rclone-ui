import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { prefs } from './core/api'
import { coreKey } from './core/query'

type Values = { [key: string]: string | undefined }

const prefsQuery = {
    queryKey: coreKey('prefs', 'Get'),
    queryFn: (): Promise<Values> => prefs.Get([]),
}

export const PREF_DEFAULTS = {
    theme: 'dark' as 'light' | 'dark' | 'system',
    acknowledgements: [] as string[],
    hiddenLocalPaths: [] as string[],
    folderSizes: true as boolean,
    fileDates: false as boolean,
    hiddenFiles: false as boolean,
    lastSourceFolder: '' as string,
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
