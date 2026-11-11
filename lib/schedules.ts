// The schedules, as the pages use them. A schedule runs an operation's form at set times while
// the app runs (core/schedules). schedules.changed keeps the queries fresh, so the writes here
// only call the core.

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounce } from 'use-debounce'
import { schedules as api } from './core/api'
import { coreKey } from './core/query'
import type { Operations, Schedules } from './core/types'
import { type OperationName, operationOf } from './operations'

type Schedule = Schedules.Schedule

export function useSchedules() {
    return useQuery({ queryKey: coreKey('schedules', 'List'), queryFn: () => api.List() })
}

/** A schedule that doesn't exist fails with not_found, so the query doesn't retry. */
export function useSchedule(id: string | null) {
    return useQuery({
        queryKey: coreKey('schedules', 'Get', { id }),
        queryFn: () => api.Get(id ?? ''),
        enabled: !!id,
        retry: false,
    })
}

/**
 * Asks the core about a schedule's time (a cron expression): its next runs, or what is wrong with
 * it. `described` is the debounced time that the answer is for. The previous answer stays while a
 * new one loads, so a caller that must not show an old answer checks `isPlaceholderData`.
 */
export function useWhenDescription(when: string) {
    const [described] = useDebounce(when, 300)
    const description = useQuery({
        queryKey: coreKey('schedules', 'Describe', { when: described }),
        queryFn: () => api.Describe(described),
        enabled: described.trim() !== '',
        placeholderData: keepPreviousData,
    })
    return { described, description }
}

/**
 * The names of the options that a schedule saved from `form` would leave off, because they are
 * for a single run ("Dry run", "Resync", "Force"). The core applies the same rule when it saves
 * (schedules.LeftOff). Undefined until the first answer, and while `form` is null.
 */
export function useLeftOff(form: Operations.Form | null | undefined): string[] | undefined {
    const key = form ? JSON.stringify(form) : ''
    const [asked] = useDebounce(key, 400)
    const query = useQuery({
        queryKey: coreKey('schedules', 'LeftOff', asked),
        queryFn: () => api.LeftOff(JSON.parse(asked) as Operations.Form),
        enabled: asked !== '',
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
        placeholderData: keepPreviousData,
    })
    if (!form) return undefined
    return query.data ?? undefined
}

/**
 * An empty id creates a schedule. The core rejects a bad name or time as field errors
 * (refusedFields), and rejects with not_found when the schedule was deleted meanwhile.
 */
export function saveSchedule(input: Schedules.Input): Promise<Schedule> {
    return api.Save(input)
}

export async function setSchedulePaused(id: string, paused: boolean): Promise<void> {
    await (paused ? api.Pause(id) : api.Resume(id))
}

export async function runScheduleNow(id: string): Promise<void> {
    await api.RunNow(id)
}

/** Runs a bisync schedule's first merge of its two folders again. */
export async function mergeScheduleAgain(id: string): Promise<void> {
    await api.MergeAgain(id)
}

/** The copy is paused until the user turns it on. */
export function duplicateSchedule(id: string): Promise<Schedule> {
    return api.Duplicate(id)
}

/** The schedule's past runs stay in History. */
export async function deleteSchedule(id: string): Promise<void> {
    await api.Delete(id)
}

/** The form that a run of the template saved under `id` would start for `operation`. */
export function scheduleFromTemplate(
    id: string,
    operation: OperationName
): Promise<Operations.Form> {
    return api.FromTemplate(id, operationOf(operation))
}
