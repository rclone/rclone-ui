import { describe, expect, it } from 'vitest'
import type { Watchers } from '../../../lib/core/types'
import { matchAny } from '../../components/list/list'
import { deletesCopy, firstLine, resyncQuestion, searchFields, statusOf, summaryOf } from './status'

function watcher(over: Partial<Watchers.Watcher> = {}): Watchers.Watcher {
    return {
        id: 'w',
        name: 'Docs',
        pathA: '/Users/me/Docs',
        pathB: 'gdrive:Docs',
        paused: false,
        createdAt: 1,
        baselined: false,
        lastRunAt: null,
        lastResult: '',
        lastError: '',
        lastChangeAt: null,
        lastChangeId: '',
        lastTransferId: '',
        attention: '',
        deletedSide: '',
        resyncing: false,
        ...over,
    }
}

describe('statusOf', () => {
    it('is Initializing until the first merge succeeds', () => {
        expect(statusOf(watcher()).label).toBe('Initializing')
        expect(statusOf(watcher({ lastResult: 'synced' })).label).toBe('Initializing')
        expect(statusOf(watcher()).kind).toBe('active')
    })
    it('is Active once baselined', () => {
        expect(statusOf(watcher({ baselined: true, lastResult: 'synced' }))).toEqual({
            label: 'Active',
            kind: 'success',
        })
    })
    it('is Failing after an ordinary failure, baselined or not', () => {
        for (const baselined of [true, false]) {
            expect(statusOf(watcher({ baselined, lastResult: 'failed' }))).toEqual({
                label: 'Failing',
                kind: 'warning',
            })
        }
    })
    it('is Paused when paused', () => {
        expect(statusOf(watcher({ paused: true, lastResult: 'failed' }))).toEqual({
            label: 'Paused',
            kind: 'idle',
        })
    })
    it('is Initializing during a Resync, even when it needs attention', () => {
        expect(
            statusOf(watcher({ resyncing: true, baselined: true, attention: 'deletes' }))
        ).toEqual({ label: 'Initializing', kind: 'active' })
        expect(statusOf(watcher({ resyncing: true, baselined: true, paused: true })).label).toBe(
            'Initializing'
        )
    })
    it('says Needs attention first', () => {
        expect(
            statusOf(watcher({ paused: true, attention: 'deletes', lastResult: 'failed' }))
        ).toEqual({ label: 'Needs attention', kind: 'danger' })
    })
})

describe('deletesCopy', () => {
    it('names the folder that lost the files and the other one', () => {
        expect(deletesCopy(watcher({ deletedSide: 'b' }))).toEqual({
            explanation:
                'Many files were deleted in gdrive:Docs since the last sync, so the watcher stopped to make sure that was intended.',
            deleteLabel: 'Delete them in /Users/me/Docs too',
            deleteQuestion: "Delete the same files in /Users/me/Docs? This can't be undone.",
        })
        expect(deletesCopy(watcher({ deletedSide: 'a' })).deleteLabel).toBe(
            'Delete them in gdrive:Docs too'
        )
    })
    it('reads the same when every file was deleted', () => {
        expect(deletesCopy(watcher({ attention: 'emptied', deletedSide: 'a' })).deleteLabel).toBe(
            'Delete them in gdrive:Docs too'
        )
        expect(statusOf(watcher({ attention: 'emptied', baselined: true })).label).toBe(
            'Needs attention'
        )
    })
    it('says one of the folders and both folders when the side is not known', () => {
        const copy = deletesCopy(watcher())
        expect(copy.explanation).toContain('deleted in one of the folders since')
        expect(copy.deleteQuestion).toBe(
            "Delete the same files in both folders? This can't be undone."
        )
    })
})

it('firstLine keeps the first line', () => {
    expect(firstLine('  one\ntwo\n')).toBe('one')
    expect(firstLine('')).toBe('')
})

it('resyncQuestion names both folders', () => {
    expect(resyncQuestion(watcher())).toBe(
        'Merge /Users/me/Docs and gdrive:Docs again? Files missing on one side are copied over, and where both have a file, the newer one is kept. Nothing is deleted.'
    )
})

it('searchFields searches names and folders', () => {
    const list = [
        watcher({ id: '1', name: 'Docs' }),
        watcher({ id: '2', name: 'Photos', pathB: 's3:pics' }),
    ]
    expect(matchAny(list, 'PICS', searchFields).map((w) => w.id)).toEqual(['2'])
    expect(matchAny(list, 'docs', searchFields).map((w) => w.id)).toEqual(['1', '2'])
})

it('summaryOf counts the watchers that run, and those that need the user', () => {
    expect(summaryOf([watcher(), watcher({ paused: true })])).toBe('1 watching, 1 paused.')
    expect(
        summaryOf([watcher({ attention: 'deletes' }), watcher({ attention: 'x', resyncing: true })])
    ).toBe('2 watching. 1 needs you.')
})
