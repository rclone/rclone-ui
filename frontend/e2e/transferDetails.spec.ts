import { expect, test } from '@playwright/test'
import { generalErrors, splitFiles } from '../lib/transfers/details'

// lib/transfers/details.ts is pure: what the transfer drawer's sections hold, and which errors
// belong to no file and so go at its top. The shapes are rclone's own, read off a real daemon: a
// folder input's error, a sync's `error` and the last failed file's `error` are one and the same
// string, while an input that never became a file (a `copyfile` of something that is not there)
// has an error no row shows.

const LOCKED =
    "couldn't copy from /data/src/sub/locked.txt to /data/dst/sub/locked.txt.c4bd8624.partial: errno -1"
const locked = { name: 'sub/locked.txt', error: LOCKED, what: 'transferring' }
const fine = { name: 'fine.txt', error: '', what: 'transferring' }

test('an error a failed file already shows is not repeated at the top; one that has no row is', () => {
    const status = {
        error: '',
        output: {
            results: [
                {
                    error: LOCKED,
                    input: { _path: 'sync/copy', srcFs: '/data/src/', dstFs: '/data/dst' },
                },
                {
                    error: 'object not found',
                    input: {
                        _path: 'operations/copyfile',
                        srcFs: '/data/',
                        srcRemote: 'missing.txt',
                        dstFs: '/data/dst',
                        dstRemote: 'missing.txt',
                    },
                },
                { input: { _path: 'operations/copyfile', srcFs: '/data/', srcRemote: 'ok.txt' } },
            ],
        },
    }
    expect(
        generalErrors({ status, recorded: '2 of 3 operations failed', failed: [locked] })
    ).toEqual([{ subject: 'missing.txt', error: 'object not found' }])

    // The file fell out of what was kept: its error has no row, so it is shown, by its folder.
    expect(generalErrors({ status, recorded: '2 of 3 operations failed', failed: [] })).toEqual([
        { subject: '/data/src/', error: LOCKED },
        { subject: 'missing.txt', error: 'object not found' },
    ])
})

test('a sync’s error is general only when no file carries it', () => {
    expect(
        generalErrors({ status: { error: LOCKED, output: {} }, recorded: LOCKED, failed: [locked] })
    ).toEqual([])
    expect(
        generalErrors({
            status: { error: 'directory not found', output: {} },
            recorded: 'directory not found',
            failed: [],
        })
    ).toEqual([{ subject: null, error: 'directory not found' }])
})

test('with no answer from rclone the record speaks; with one, the record’s summary never does', () => {
    const lost = 'Lost contact with its rclone daemon: connection refused'
    expect(generalErrors({ status: undefined, recorded: lost, failed: [] })).toEqual([
        { subject: null, error: lost },
    ])
    expect(generalErrors({ status: undefined, recorded: null, failed: [] })).toEqual([])
    // Still running, or over with nothing wrong: rclone answered, and said nothing.
    expect(
        generalErrors({ status: { error: '' }, recorded: '1 of 2 operations failed', failed: [] })
    ).toEqual([])
})

test('files go to the section that says how they ended', () => {
    expect(splitFiles([fine, locked])).toEqual({ transferred: [fine], failed: [locked] })
    expect(splitFiles(undefined)).toEqual({ transferred: [], failed: [] })
    // What was collected while it ran outlasts rclone's last hundred, so it is what Failed holds.
    const early = { name: 'early.txt', error: 'permission denied' }
    expect(splitFiles([fine, locked], [early, locked])).toEqual({
        transferred: [fine],
        failed: [early, locked],
    })
})
