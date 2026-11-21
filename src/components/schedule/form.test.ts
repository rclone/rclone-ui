import { describe, expect, it } from 'vitest'
import type { Operations } from '../../../lib/core/types'
import { type ArgsOf, formOf } from '../../../lib/operations'
import {
    defaultName,
    operationLine,
    pathsLine,
    type ScheduleOperation,
    singleRunLine,
} from './form'

function form<O extends ScheduleOperation>(operation: O, args: ArgsOf<O>): Operations.Form {
    return formOf(operation, args)
}

describe('defaultName', () => {
    it('names a transfer after its first source and its destination', () => {
        expect(
            defaultName(
                form('copy', { sources: ['/Users/me/Photos'], destination: 'gdrive:Backup' })
            )
        ).toBe('Copy Photos to Backup')
        expect(
            defaultName(
                form('move', {
                    sources: ['/Users/me/Photos', '/Users/me/Videos', '/Users/me/Music'],
                    destination: 'gdrive:',
                })
            )
        ).toBe('Move Photos and 2 more to gdrive')
        expect(
            defaultName(form('sync', { source: 'gdrive:Docs/', destination: '/Users/me/Docs' }))
        ).toBe('Sync Docs to Docs')
    })
    it('names a bisync after its two folders', () => {
        expect(
            defaultName(form('bisync', { source: '/Users/me/Notes', destination: 'dropbox:Notes' }))
        ).toBe('Bisync Notes and Notes')
    })
    it('names a delete or a purge after its paths', () => {
        expect(defaultName(form('delete', { sources: ['/tmp/cache'] }))).toBe('Delete cache')
        expect(defaultName(form('purge', { sources: ['s3:old', 's3:older'] }))).toBe(
            'Purge old and 1 more'
        )
    })
})

describe('pathsLine', () => {
    it('shows the paths as a row does', () => {
        expect(pathsLine(form('copy', { sources: ['/a', '/b'], destination: 'r:c' }))).toBe(
            '/a, /b → r:c'
        )
        expect(pathsLine(form('bisync', { source: '/a', destination: 'r:b' }))).toBe('/a ↔ r:b')
        expect(pathsLine(form('purge', { sources: ['/a', '/b'] }))).toBe('/a, /b')
    })
})

describe('operationLine', () => {
    it('has none for Copy', () => {
        expect(operationLine(form('copy', { sources: ['/a'], destination: 'r:b' }))).toBeNull()
    })
    it('says what Sync deletes', () => {
        expect(operationLine(form('sync', { source: '/a', destination: 'r:b' }))).toBe(
            "Each run deletes the files in r:b that aren't in /a."
        )
    })
    it('says that Move takes what is there at the time', () => {
        expect(operationLine(form('move', { sources: ['/a', '/b'], destination: 'r:c' }))).toBe(
            'Each run moves what is in /a, /b at that time. When there is nothing there, the run does nothing.'
        )
    })
    it('says what Delete deletes, with or without filters', () => {
        expect(operationLine(form('delete', { sources: ['/a'] }))).toBe(
            'Each run deletes the files that are in /a at that time.'
        )
        expect(
            operationLine(
                form('delete', {
                    sources: ['/a', '/b'],
                    options: { filter: { include: ['*.tmp'] } },
                })
            )
        ).toBe(
            'Each run deletes the files that are in /a, /b at that time, that match the filters.'
        )
        // ignore_case changes how the rules apply, and selects nothing on its own.
        expect(
            operationLine(
                form('delete', { sources: ['/a'], options: { filter: { ignore_case: true } } })
            )
        ).toBe('Each run deletes the files that are in /a at that time.')
    })
    it('says what Purge deletes', () => {
        expect(operationLine(form('purge', { sources: ['/a'] }))).toBe(
            "Each run deletes /a and everything in it. When it's gone, the run does nothing."
        )
        expect(operationLine(form('purge', { sources: ['/a', '/b'] }))).toBe(
            "Each run deletes /a, /b and everything in them. When they're gone, the run does nothing."
        )
    })
    it('says that a first bisync merges', () => {
        expect(operationLine(form('bisync', { source: '/a', destination: 'r:b' }))).toBe(
            'If the two folders were never bisynced together, the first run merges them. Files missing on one side are copied over, and where both have a file, the newer one is kept.'
        )
    })
})

describe('singleRunLine', () => {
    it("says what the core leaves off, in the core's order", () => {
        expect(singleRunLine([])).toBeNull()
        expect(singleRunLine(undefined)).toBeNull()
        expect(singleRunLine(['Dry run'])).toBe(
            'Dry run is for a single run, so the schedule leaves it off.'
        )
        expect(singleRunLine(['Resync', 'Force'])).toBe(
            'Resync and Force are for a single run, so the schedule leaves them off.'
        )
        expect(singleRunLine(['Dry run', 'Resync', 'Force'])).toBe(
            'Dry run, Resync, and Force are for a single run, so the schedule leaves them off.'
        )
    })
})
