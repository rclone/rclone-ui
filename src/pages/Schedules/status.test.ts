import { describe, expect, it } from 'vitest'
import type { Schedules } from '../../../lib/core/types'
import { formOf } from '../../../lib/operations'
import { matchAny } from '../../components/list/list'
import {
    deleteQuestion,
    firstLine,
    lastRunOf,
    mergeQuestion,
    nextLine,
    notesOf,
    runQuestion,
    searchFields,
    summaryOf,
} from './status'

const NOW = new Date(2026, 10, 9, 12, 0).getTime()
const HOUR = 3_600_000

/** Builds a schedule, which copies Photos unless `over` has another form. */
function schedule(over: Partial<Schedules.Schedule> = {}): Schedules.Schedule {
    return {
        id: 's',
        name: 'Photos',
        form: formOf('copy', { sources: ['/Users/me/Photos'], destination: 'gdrive:Photos' }),
        when: '0 2 * * *',
        paused: false,
        createdAt: 1,
        baselined: false,
        lastRunAt: null,
        lastResult: '',
        lastError: '',
        lastTransferId: '',
        lastSkippedAt: null,
        running: false,
        runningId: '',
        nextRun: null,
        ...over,
    }
}

describe('lastRunOf', () => {
    it('says Never ran before the first run', () => {
        expect(lastRunOf(schedule(), NOW)).toEqual({
            label: 'Never ran',
            kind: 'idle',
            ago: '',
            note: '',
            transferId: '',
        })
    })
    it('says Running while a run is in progress, over anything else', () => {
        const s = schedule({
            running: true,
            runningId: 't2',
            paused: true,
            lastResult: 'failed',
            lastRunAt: NOW - HOUR,
            lastTransferId: 't1',
        })
        expect(lastRunOf(s, NOW)).toEqual({
            label: 'Running',
            kind: 'active',
            ago: '',
            note: '',
            transferId: 't2',
        })
    })
    it('says how the last run ended, and when', () => {
        const ended = { lastRunAt: NOW - 3 * HOUR, lastTransferId: 't1' }
        expect(lastRunOf(schedule({ ...ended, lastResult: 'completed' }), NOW)).toEqual({
            label: 'Succeeded',
            kind: 'success',
            ago: '3 hours ago',
            note: '',
            transferId: 't1',
        })
        expect(lastRunOf(schedule({ ...ended, lastResult: 'failed' }), NOW)).toMatchObject({
            label: 'Failed',
            kind: 'danger',
            ago: '3 hours ago',
        })
        expect(lastRunOf(schedule({ ...ended, lastResult: 'stopped' }), NOW)).toMatchObject({
            label: 'Stopped',
            kind: 'idle',
            ago: '3 hours ago',
        })
        expect(lastRunOf(schedule({ ...ended, lastResult: 'interrupted' }), NOW).label).toBe(
            'Stopped'
        )
    })
    it('counts a run with nothing to do as a success, says so after when, with no run to open', () => {
        const s = schedule({ lastResult: 'nothing', lastRunAt: NOW - HOUR })
        expect(lastRunOf(s, NOW)).toEqual({
            label: 'Succeeded',
            kind: 'success',
            ago: '1 hour ago',
            note: 'Nothing to do',
            transferId: '',
        })
    })
    it('opens nothing for a refused run', () => {
        const s = schedule({ lastResult: 'failed', lastRunAt: NOW - HOUR, lastError: 'nope' })
        expect(lastRunOf(s, NOW).transferId).toBe('')
    })
})

describe('nextLine', () => {
    it('says when the next run is, or nothing while paused', () => {
        expect(nextLine('Photos', null, NOW)).toBe('')
        expect(nextLine('Photos', NOW - 1, NOW)).toBe('Next: Photos, soon.')
        expect(nextLine('Photos', NOW + 3 * HOUR, NOW)).toBe('Next: Photos, in 3 hours.')
        expect(nextLine('Photos', new Date(2026, 10, 11, 2, 0).getTime(), NOW)).toBe(
            'Next: Photos, Wed, Nov 11, 02:00.'
        )
    })
})

describe('summaryOf', () => {
    it('names the next run, and the runs in progress', () => {
        const list = [
            schedule({ name: 'Later', nextRun: NOW + 5 * HOUR }),
            schedule({ name: 'Soon', nextRun: NOW + HOUR, running: true }),
            schedule({ name: 'Off', paused: true }),
        ]
        expect(summaryOf(list, NOW)).toBe('1 running now. Next: Soon, in 1 hour.')
        expect(summaryOf([schedule({ paused: true })], NOW)).toBe('All paused.')
    })
})

describe('notesOf', () => {
    it('says the error and a skipped time', () => {
        expect(notesOf(schedule({ lastResult: 'failed', lastError: 'boom\nmore' })).error).toBe(
            'boom\nmore'
        )
        expect(
            notesOf(schedule({ lastSkippedAt: new Date(2026, 10, 9, 2, 0).getTime() })).skipped
        ).toBe('Skipped Mon, Nov 9, 02:00. The last run was still going.')
    })
    it('waits while a run is in progress', () => {
        const notes = notesOf(schedule({ running: true, lastResult: 'failed', lastError: 'x' }))
        expect(notes.error).toBe('')
    })
})

describe('firstLine', () => {
    it('keeps the first line', () => {
        expect(firstLine('  one\ntwo')).toBe('one')
    })
})

describe('questions', () => {
    it('asks before a run, with the page warning for Sync, Delete and Purge', () => {
        expect(runQuestion(schedule())).toEqual({ text: 'Run Photos now?', warning: false })
        expect(
            runQuestion(schedule({ form: formOf('sync', { source: '/a', destination: 'r:b' }) }))
        ).toEqual({
            text: "Run Photos now?\n\nFiles in r:b that aren't in /a will be deleted.",
            warning: true,
        })
        expect(runQuestion(schedule({ form: formOf('purge', { sources: ['/a'] }) })).text).toBe(
            "Run Photos now?\n\nPurge /a? It is removed with everything in it, and this can't be undone."
        )
        expect(runQuestion(schedule({ form: formOf('delete', { sources: ['/a'] }) })).text).toBe(
            "Run Photos now?\n\nDelete the files at /a? This can't be undone."
        )
    })
    it('asks before a merge and a delete', () => {
        const s = schedule({ form: formOf('bisync', { source: '/a', destination: 'r:b' }) })
        expect(mergeQuestion(s)).toBe(
            'Merge /a and r:b again? Files missing on one side are copied over, and where both have a file, the newer one is kept. Nothing is deleted.'
        )
        expect(deleteQuestion(s)).toBe('Delete the schedule Photos? Its past runs stay in History.')
    })
})

describe('searchFields', () => {
    it('finds schedules by name or path', () => {
        const list = [
            schedule(),
            schedule({
                id: 'b',
                name: 'Docs',
                form: formOf('sync', { source: '/d', destination: 'x:y' }),
            }),
        ]
        expect(matchAny(list, 'docs', searchFields).map((s) => s.id)).toEqual(['b'])
        expect(matchAny(list, 'GDRIVE', searchFields).map((s) => s.id)).toEqual(['s'])
    })
})
