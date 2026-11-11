import { plural, t } from '@lingui/core/macro'
import type { Operations } from '../../../lib/core/types'
import { getRemoteName } from '../../../lib/format'
import { locale } from '../../../lib/i18n'
import { endsOf, groupsOf, type OperationName } from '../../../lib/operations'
import { baseName } from '../../../lib/paths'
import { hasFilters } from '../operation/confirmations'

// What the drawer and the list say about a schedule's form: the operation's form (core/operations)
// that each run starts from, as the operation's page builds it.

export const SCHEDULE_OPERATIONS = [
    'copy',
    'move',
    'sync',
    'bisync',
    'delete',
    'purge',
] as const satisfies readonly OperationName[]
export type ScheduleOperation = (typeof SCHEDULE_OPERATIONS)[number]

export function isScheduleOperation(operation: string): operation is ScheduleOperation {
    return (SCHEDULE_OPERATIONS as readonly string[]).includes(operation)
}

export const OPERATION_LABELS: Record<ScheduleOperation, string> = {
    copy: t`Copy`,
    move: t`Move`,
    sync: t`Sync`,
    bisync: t`Bisync`,
    delete: t`Delete`,
    purge: t`Purge`,
}

export function editOperationLabel(): string {
    return t({
        message: 'Edit the operation',
        comment:
            "Opens the operation's window (Copy, Sync…) with the schedule's form, to change it.",
    })
}

/** The core saves only the six operations, so any other one reads as Copy. */
export function scheduleOperation(form: Operations.Form): ScheduleOperation {
    const operation: string = form.operation
    return isScheduleOperation(operation) ? operation : 'copy'
}

export function pathName(path: string): string {
    return baseName(path) || getRemoteName(path) || path
}

/** "Photos", or "Photos and 2 more" when there are several. */
function namesOf(paths: readonly string[]): string {
    const first = paths[0] ? pathName(paths[0]) : ''
    if (paths.length <= 1) return first
    const more = paths.length - 1
    return plural(more, { one: `${first} and # more`, other: `${first} and # more` })
}

/**
 * The name a new schedule gets: "Copy Photos to Backup", "Bisync Docs and Docs", "Delete Old and
 * 2 more".
 */
export function defaultName(form: Operations.Form): string {
    const ends = endsOf(form)
    const sources = ends.sources
    const destination = ends.destination ? pathName(ends.destination) : ''
    const from = namesOf(sources)
    const name = (() => {
        switch (scheduleOperation(form)) {
            case 'bisync': {
                const first = pathName(sources[0] ?? '')
                const second = destination
                return t`Bisync ${first} and ${second}`
            }
            case 'delete':
                return t`Delete ${from}`
            case 'purge':
                return t`Purge ${from}`
            case 'move':
                return destination ? t`Move ${from} to ${destination}` : t`Move ${from}`
            case 'sync':
                return destination ? t`Sync ${from} to ${destination}` : t`Sync ${from}`
            default:
                return destination ? t`Copy ${from} to ${destination}` : t`Copy ${from}`
        }
    })()
    return name.trim()
}

/**
 * The paths as a row shows them: "a, b → c", "A ↔ B", or the paths alone for Delete and Purge.
 */
export function pathsLine(form: Operations.Form): string {
    const { sources, destination } = endsOf(form)
    const operation: string = form.operation
    if (operation === 'delete' || operation === 'purge' || !destination) return sources.join(', ')
    const arrow = operation === 'bisync' ? '↔' : '→'
    return `${sources.join(', ')} ${arrow} ${destination}`
}

/**
 * The line that the drawer shows for an operation, in place of the question that Start would
 * ask. Copy has none.
 */
export function operationLine(form: Operations.Form): string | null {
    const { sources, destination } = endsOf(form)
    const paths = sources.join(', ')
    switch (scheduleOperation(form)) {
        case 'sync':
            return t`Each run deletes the files in ${destination} that aren't in ${paths}.`
        case 'move':
            return t`Each run moves what is in ${paths} at that time. When there is nothing there, the run does nothing.`
        case 'delete': {
            const options = groupsOf(form)
            return hasFilters(options?.filter, options?.metadata)
                ? t`Each run deletes the files that are in ${paths} at that time, that match the filters.`
                : t`Each run deletes the files that are in ${paths} at that time.`
        }
        case 'purge':
            return sources.length > 1
                ? t`Each run deletes ${paths} and everything in them. When they're gone, the run does nothing.`
                : t`Each run deletes ${paths} and everything in it. When it's gone, the run does nothing.`
        case 'bisync':
            return t`If the two folders were never bisynced together, the first run merges them. Files missing on one side are copied over, and where both have a file, the newer one is kept.`
        default:
            return null
    }
}

function listed(names: readonly string[]): string {
    return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(names)
}

/**
 * The line that says what the schedule leaves off, from the names that the core gives
 * (schedules.LeftOff): "Dry run, Resync, and Force are for a single run, so the schedule leaves
 * them off." It is null when there are none.
 */
export function singleRunLine(names: readonly string[] | undefined): string | null {
    if (!names || names.length === 0) return null
    const list = listed(names)
    const count = names.length
    return plural(count, {
        one: `${list} is for a single run, so the schedule leaves it off.`,
        other: `${list} are for a single run, so the schedule leaves them off.`,
    })
}
