import { plural, t } from '@lingui/core/macro'
import type { Schedules } from '../../../lib/core/types'
import { timeAgo } from '../../../lib/format'
import { endsOf, groupsOf } from '../../../lib/operations'
import type { StatusKind } from '../../components/look/Status'
import {
    deleteQuestion as deleteFilesQuestion,
    hasFilters,
    purgeQuestion,
    syncQuestion,
} from '../../components/operation/confirmations'
import { pathsLine, scheduleOperation } from '../../components/schedule/form'
import { shortTime } from '../../components/schedule/when'

// What a schedule's row says about it. Its runs are rare and meaningful, so the row says how the
// last one went, or that one is running.

type Schedule = Schedules.Schedule

/** How a schedule's row says its last run went, in its status column. */
export interface LastRun {
    label: string
    kind: StatusKind
    /** When the last run was, such as "3 hours ago", or '' while running or before the first. */
    ago: string
    /** "Nothing to do" after a run that had nothing to do, or ''. */
    note: string
    /** The run that the status opens in History, or '' when there is none. */
    transferId: string
}

/**
 * The last run of a schedule. A run in progress shows as "Running", whatever came before.
 * "Succeeded" covers a run that changed something and one that had nothing to do. "Stopped"
 * covers a run that the user stopped and one that a quit interrupted.
 */
export function lastRunOf(s: Schedule, now: number): LastRun {
    if (s.running) {
        return { label: t`Running`, kind: 'active', ago: '', note: '', transferId: s.runningId }
    }
    const ago = s.lastRunAt === null ? '' : timeAgo(s.lastRunAt, Math.max(now, s.lastRunAt))
    const transferId = s.lastTransferId
    const succeeded = t({ message: 'Succeeded', comment: 'How the last run of a schedule went.' })
    switch (s.lastResult) {
        case 'completed':
            return { label: succeeded, kind: 'success', ago, note: '', transferId }
        case 'nothing':
            return { label: succeeded, kind: 'success', ago, note: t`Nothing to do`, transferId }
        case 'failed':
            return { label: t`Failed`, kind: 'danger', ago, note: '', transferId }
        case 'stopped':
        case 'interrupted':
            return { label: t`Stopped`, kind: 'idle', ago, note: '', transferId }
        default:
            return { label: t`Never ran`, kind: 'idle', ago: '', note: '', transferId: '' }
    }
}

/**
 * The sentence that names the schedule that runs next, and when: "in 3 hours" within a day, its
 * date after that, and "soon" when it is due. It is '' while the schedule is paused (no next run).
 */
export function nextLine(name: string, nextRun: number | null, now: number): string {
    if (nextRun === null) return ''
    // A run that is due waits for the scheduler's next tick, or for the catch-up after a start.
    if (nextRun <= now) return t`Next: ${name}, soon.`
    if (nextRun - now < DAY) {
        const relative = timeAgo(nextRun, now)
        return t({
            message: `Next: ${name}, ${relative}.`,
            comment: '{relative} is how long until the run: "Next: Photos, in 3 hours."',
        })
    }
    const date = shortTime(nextRun)
    return t({
        message: `Next: ${name}, ${date}.`,
        comment: '{date} is the day and the time of the run: "Next: Photos, Mon, Nov 9, 02:00."',
    })
}

/** A day in ms. */
const DAY = 86_400_000

/** The line under the window's title: how many schedules are running, and which one runs next. */
export function summaryOf(schedules: readonly Schedule[], now: number): string {
    const running = schedules.filter((s) => s.running).length
    const on = schedules.filter((s) => !s.paused)
    const next = on
        .filter((s) => s.nextRun !== null)
        .sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))[0]
    const parts: string[] = []
    if (running > 0) {
        parts.push(
            t({
                message: plural(running, { one: '# running now.', other: '# running now.' }),
                comment: 'How many schedules are running now.',
            })
        )
    }
    if (on.length === 0) parts.push(t`All paused.`)
    else if (next) parts.push(nextLine(next.name, next.nextRun, now))
    return parts.join(' ')
}

export function firstLine(error: string): string {
    return error.trim().split('\n')[0]?.trim() ?? ''
}

/**
 * The notes under a schedule's row: the error of its last run, which is hidden while a run is in
 * progress, and a skipped time.
 */
export function notesOf(s: Schedule): { error: string; skipped: string } {
    return {
        error: !s.running && s.lastResult === 'failed' ? s.lastError.trim() : '',
        skipped: s.lastSkippedAt === null ? '' : skippedLine(s.lastSkippedAt),
    }
}

function skippedLine(at: number): string {
    const date = shortTime(at)
    return t`Skipped ${date}. The last run was still going.`
}

/**
 * The question that Run now asks: "Run {name} now?", plus the warning that the operation's page
 * shows before Sync, Delete and Purge.
 */
export function runQuestion(s: Schedule): { text: string; warning: boolean } {
    const { sources, destination } = endsOf(s.form)
    const operation = scheduleOperation(s.form)
    let warning = ''
    if (operation === 'sync') warning = syncQuestion(sources[0] ?? '', destination).text
    if (operation === 'delete') {
        const options = groupsOf(s.form)
        warning = deleteFilesQuestion(sources, hasFilters(options?.filter, options?.metadata)).text
    }
    if (operation === 'purge') warning = purgeQuestion(sources).text
    const name = s.name
    const question = t`Run ${name} now?`
    return { text: warning ? `${question}\n\n${warning}` : question, warning: !!warning }
}

export function mergeQuestion(s: Schedule): string {
    const { sources, destination } = endsOf(s.form)
    const first = sources[0] ?? ''
    return t`Merge ${first} and ${destination} again? Files missing on one side are copied over, and where both have a file, the newer one is kept. Nothing is deleted.`
}

export function deleteQuestion(s: Schedule): string {
    const name = s.name
    return t`Delete the schedule ${name}? Its past runs stay in History.`
}

export function searchFields(s: Schedule): string[] {
    return [s.name, pathsLine(s.form)]
}
