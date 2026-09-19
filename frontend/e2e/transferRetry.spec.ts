import { expect, test } from '@playwright/test'
import type { TransferDetail } from '../lib/api/transfers'
import { errorReason, fsKey, retryPlan, retryRequest } from '../lib/transfers/retry'

// lib/transfers/retry.ts is pure: what of an ended transfer can be retried, and the request that
// retries a selection of it. The shapes below are rclone's own, read off a real daemon: a failed
// batch entry echoes its input, a failed sync echoes nothing, and a file's `srcFs` comes back in
// rclone's canonical form, which is not the string the input was given.

const CONFIG = '{"IgnoreExisting":true}'
const failedFile = (name: string, srcFs: string, dstFs: string, extra: object = {}) => ({
    name,
    error: `couldn't copy ${name}: permission denied`,
    checked: false,
    what: 'transferring',
    srcFs,
    dstFs,
    ...extra,
})

const folderCopy = (results: object[], failed: object[]): TransferDetail => ({
    request: {
        endpoint: '/job/batch',
        body: {
            inputs: [
                {
                    _path: 'sync/copy',
                    srcFs: '/data/photos/',
                    dstFs: 'gdrive:backup/photos',
                    createEmptySrcDirs: true,
                    _config: CONFIG,
                    _filter: '{"MaxSize":"10M"}',
                },
            ],
            _config: CONFIG,
            _async: true,
        },
    },
    status: { error: '', output: { results } },
    transferred: [],
    failed,
})

test('a file that failed inside a folder copy is retried on its own, with the folder’s settings', () => {
    const detail = folderCopy(
        [{ error: "couldn't copy a.jpg", input: {} }],
        [failedFile('2024/a.jpg', '/data/photos', 'gdrive:backup/photos')]
    )
    const items = retryPlan(detail)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'file', label: '2024/a.jpg' })
    // Its input's ends and config; no filter, because a named file needs none (and a filter that
    // excluded it would make the retry a no-op).
    expect(items[0].input).toEqual({
        _path: 'operations/copyfile',
        srcFs: '/data/photos/',
        srcRemote: '2024/a.jpg',
        dstFs: 'gdrive:backup/photos',
        dstRemote: '2024/a.jpg',
        _config: CONFIG,
    })
    expect(items[0].source).toBe('/data/photos/2024/a.jpg')

    // A selection becomes one batch, the config repeated at its top as the builders do.
    expect(retryRequest(items, detail)).toEqual({
        endpoint: '/job/batch',
        body: { inputs: [items[0].input], _config: CONFIG, _async: true },
    })
})

test('a move retries with movefile, and what is not a transfer is not retried as one', () => {
    const detail = folderCopy(
        [{ error: 'x', input: {} }],
        [
            failedFile('a.jpg', '/data/photos', 'gdrive:backup/photos'),
            failedFile('gone.jpg', '/data/photos', 'gdrive:backup/photos', { what: 'deleting' }),
            failedFile('same.jpg', '/data/photos', 'gdrive:backup/photos', { checked: true }),
            { ...failedFile('fine.jpg', '/data/photos', 'gdrive:backup/photos'), error: '' },
        ]
    )
    ;(detail.request!.body.inputs as { _path: string }[])[0]._path = 'sync/move'
    const items = retryPlan(detail)
    expect(items.map((item) => [item.label, item.input._path])).toEqual([
        ['a.jpg', 'operations/movefile'],
    ])
})

test('an input that failed as a whole is retried as it was', () => {
    const copyfile = {
        _path: 'operations/copyfile',
        srcFs: 'gdrive:',
        srcRemote: 'docs/missing.txt',
        dstFs: '/backup',
        dstRemote: 'missing.txt',
        _config: CONFIG,
    }
    const detail: TransferDetail = {
        request: {
            endpoint: '/job/batch',
            body: {
                inputs: [
                    { _path: 'sync/copy', srcFs: '/data/ok/', dstFs: '/backup/ok' },
                    copyfile,
                    { _path: 'sync/copy', srcFs: '/data/never/', dstFs: '/backup/never' },
                ],
                _async: true,
            },
        },
        // In input order: the first succeeded, the file was not found, the last folder failed
        // before a single file of it was tried (or its failures fell out of rclone's window).
        status: {
            output: {
                results: [{}, { error: 'object not found' }, { error: 'directory not found' }],
            },
        },
        transferred: [],
        failed: [],
    }
    const items = retryPlan(detail)
    expect(items.map((item) => [item.kind, item.label, item.error])).toEqual([
        ['input', 'docs/missing.txt', 'object not found'],
        ['input', '/data/never/', 'directory not found'],
    ])
    expect(items[0].input).toEqual(copyfile)
    // A folder retried whole is a re-run of it; rclone skips what already arrived.
    expect(items[1].input).toEqual({
        _path: 'sync/copy',
        srcFs: '/data/never/',
        dstFs: '/backup/never',
    })
})

test('with several folders a failed file goes to the one it came from', () => {
    const detail: TransferDetail = {
        request: {
            endpoint: '/job/batch',
            body: {
                inputs: [
                    { _path: 'sync/copy', srcFs: 'gdrive,chunk_size=8M:a/', dstFs: '/backup/a' },
                    { _path: 'sync/copy', srcFs: 'gdrive,chunk_size=8M:b/', dstFs: '/backup/b' },
                ],
                _async: true,
            },
        },
        status: { output: { results: [{ error: 'x' }, { error: 'y' }] } },
        transferred: [],
        // rclone names an overridden remote by a hash of its overrides, not by what it was given.
        failed: [
            failedFile('readme.txt', 'gdrive{AbCdE}:b', '/backup/b'),
            failedFile('stray.txt', 'elsewhere:', '/nowhere'),
        ],
    }
    const items = retryPlan(detail)
    expect(items.map((item) => [item.kind, item.label])).toEqual([
        // `a` failed with no file of its own known: retried whole.
        ['input', 'gdrive,chunk_size=8M:a/'],
        ['file', 'readme.txt'],
    ])
    expect(items[1].input).toMatchObject({ srcFs: 'gdrive,chunk_size=8M:b/', dstFs: '/backup/b' })
    // A file that matches no folder is not guessed at.
    expect(items.some((item) => item.label === 'stray.txt')).toBe(false)
})

test('a sync’s failed files are copied; the sync itself is never re-run with a filter', () => {
    const detail: TransferDetail = {
        request: {
            endpoint: '/sync/sync',
            body: { srcFs: '/data/site', dstFs: 's3:bucket/site', _config: CONFIG, _async: true },
        },
        // A failed sync echoes nothing: `output` is empty, the request is all there is.
        status: { error: "couldn't copy index.html", output: {} },
        transferred: [],
        failed: [failedFile('index.html', '/data/site', 's3:bucket/site')],
    }
    const items = retryPlan(detail)
    expect(items).toHaveLength(1)
    expect(items[0].input).toEqual({
        _path: 'operations/copyfile',
        srcFs: '/data/site',
        srcRemote: 'index.html',
        dstFs: 's3:bucket/site',
        dstRemote: 'index.html',
        _config: CONFIG,
    })
    expect(retryRequest(items, detail).endpoint).toBe('/job/batch')

    // Bisync keeps its own account of both sides; a file copied behind its back is a change it
    // then has to explain. Run again is the answer there.
    const bisync: TransferDetail = {
        ...detail,
        request: { endpoint: '/sync/bisync', body: { path1: '/a', path2: 'b:' } },
    }
    expect(retryPlan(bisync)).toEqual([])
})

test('a stopped transfer can still retry what failed before the stop', () => {
    // Stopped: no results to say which inputs failed, but the files collected while it ran.
    const stopped = folderCopy([], [failedFile('a.jpg', '/data/photos', 'gdrive:backup/photos')])
    stopped.status = {}
    expect(retryPlan(stopped).map((item) => item.label)).toEqual(['a.jpg'])

    // Without the request there is nothing to retry against.
    expect(retryPlan({ ...stopped, request: undefined })).toEqual([])
    expect(retryPlan(null)).toEqual([])
})

test('an fs is recognised whatever form rclone gives it back in', () => {
    expect(fsKey('/data/photos/')).toBe('/data/photos')
    expect(fsKey('gdrive:photos/')).toBe('gdrive:photos')
    expect(fsKey('gdrive,chunk_size=8M:photos')).toBe('gdrive:photos')
    expect(fsKey('gdrive{AbCdE}:photos')).toBe('gdrive:photos')
    expect(fsKey(':local,copy_links=true:/tmp/x')).toBe(':local:/tmp/x')
    expect(fsKey(':local{12rtk}:/tmp/x')).toBe(':local:/tmp/x')
    // A colon inside a quoted option value does not end the remote's name.
    expect(fsKey(':sftp,host="a:b",user=me:/srv')).toBe(':sftp:/srv')
    // A Windows drive is a path, not a remote.
    expect(fsKey('C:\\data\\photos\\')).toBe('C:\\data\\photos')
})

test('failed files are listed by name, and an error is shown by its reason', () => {
    // rclone lists files in the order they finished, which helps nobody find one among many.
    const detail = folderCopy(
        [{ error: 'x' }],
        ['Porto/b.jpg', 'Lisbon/z.jpg', 'Lisbon/a.jpg'].map((name) =>
            failedFile(name, '/data/photos', 'gdrive:backup/photos')
        )
    )
    expect(retryPlan(detail).map((item) => item.label)).toEqual([
        'Lisbon/a.jpg',
        'Lisbon/z.jpg',
        'Porto/b.jpg',
    ])

    // rclone's errors lead with paths the row already shows and end with what went wrong; a
    // clamped line has to spend its room on the end.
    expect(
        errorReason(
            "couldn't copy from /data/photos/a.jpg to /backup/a.jpg.f39.partial: open /data/photos/a.jpg: permission denied"
        )
    ).toBe('permission denied')
    expect(
        errorReason(
            "googleapi: Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded"
        )
    ).toBe("The user's Drive storage quota has been exceeded., storageQuotaExceeded")
    expect(errorReason('object not found')).toBe('object not found')
    // Never an empty line: a message that ends in a colon keeps its whole text.
    expect(errorReason('failed: ')).toBe('failed:')
})
