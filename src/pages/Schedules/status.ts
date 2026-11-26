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

type Schedule = Schedules.Schedule

export interface LastRun {
    label: string
    kind: StatusKind
    ago: string
    note: string
    transferId: string
}

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

export function nextLine(name: string, nextRun: number | null, now: number): string {
    if (nextRun === null) return ''
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

const DAY = 86_400_000

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
