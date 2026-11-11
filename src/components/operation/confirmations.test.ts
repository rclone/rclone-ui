import { describe, expect, it } from 'vitest'
import {
    bisyncQuestion,
    deleteQuestion,
    hasFilters,
    purgeQuestion,
    syncQuestion,
} from './confirmations'

describe('the questions before a start', () => {
    it('names what Delete deletes, and where', () => {
        expect(deleteQuestion(['gdrive:Backups/2023'], false)).toEqual({
            title: 'Delete files',
            text: "Delete the files at gdrive:Backups/2023? This can't be undone.",
            start: 'Delete',
            destructive: true,
        })
        expect(deleteQuestion(['gdrive:a', 'gdrive:b'], false).text).toBe(
            "Delete the files at these 2 paths? This can't be undone.\n\ngdrive:a\ngdrive:b"
        )
    })

    it('keeps the filters wording', () => {
        expect(deleteQuestion(['gdrive:Backups/2023'], true)).toEqual({
            title: 'Delete files',
            text: 'Permanently delete the files matching your filters in gdrive:Backups/2023?',
            start: 'Delete Matching Files',
            destructive: true,
        })
        expect(deleteQuestion(['gdrive:a', 'gdrive:b'], true).text).toBe(
            'Permanently delete the files matching your filters in these 2 paths?\n\ngdrive:a\ngdrive:b'
        )
    })

    it('names what Purge removes', () => {
        expect(purgeQuestion(['gdrive:Backups/2023'])).toEqual({
            title: 'Purge',
            text: "Purge gdrive:Backups/2023? It is removed with everything in it, and this can't be undone.",
            start: 'Purge',
            destructive: true,
        })
        expect(purgeQuestion(['gdrive:a', 'mem:b']).text).toBe(
            "Purge these 2 paths? Each is removed with everything in it, and this can't be undone.\n\ngdrive:a\nmem:b"
        )
    })

    it('says that Bisync works both ways, and what resync and force change', () => {
        expect(bisyncQuestion('/a', 'mem:b')).toEqual({
            title: 'Bisync',
            text: 'Bisync /a and mem:b? Changes and deletions on either side are made on the other too.',
            start: 'Start bisync',
        })
        expect(bisyncQuestion('/a', 'mem:b', { resync: true, force: true }).text).toBe(
            [
                'Bisync /a and mem:b? Changes and deletions on either side are made on the other too.',
                'Resync is on. Where the two sides differ, the version in /a replaces the one in mem:b.',
                'Force is on. Bisync will not stop when many files are deleted or changed at a time.',
            ].join('\n\n')
        )
    })

    it('says what Sync deletes, and offers a dry run', () => {
        expect(syncQuestion('~/Photos', 'gdrive:Photos')).toEqual({
            text: "Files in gdrive:Photos that aren't in ~/Photos will be deleted.",
            start: 'Start sync',
            dryRun: 'Dry run first',
        })
    })
})

describe('hasFilters', () => {
    it('is false with no rules', () => {
        expect(hasFilters()).toBe(false)
        expect(hasFilters({}, {})).toBe(false)
    })

    it('is true with a rule set to something', () => {
        expect(hasFilters({ exclude: ['*.tmp'] })).toBe(true)
        expect(hasFilters({ max_age: '30d' })).toBe(true)
        expect(hasFilters({}, { metadata_include: ['mime=image/*'] })).toBe(true)
    })

    it('reads rules without a value as none', () => {
        expect(hasFilters({ exclude: [], include: [''], max_age: 'off', files_from: null })).toBe(
            false
        )
        expect(hasFilters({ ignore_case: true })).toBe(false)
        // The metadata group's other options don't select files.
        expect(hasFilters({}, { metadata: true })).toBe(false)
    })
})
