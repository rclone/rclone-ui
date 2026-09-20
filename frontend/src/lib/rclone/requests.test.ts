import { expect, test } from 'vitest'
import {
    buildBisyncRequests,
    buildCopyRequests,
    buildDeleteRequests,
    buildMoveRequests,
    buildPurgeRequests,
    buildSyncRequests,
    configParamOf,
    type Kinds,
} from './requests'

// lib/rclone/requests.ts is pure, so it runs in the test process itself. The requests the six
// builders produce for one fixed set of arguments are pinned as snapshots: the live start path
// and the scheduler's task files both come from here, and a refactor must change nothing.

const remotes = { gdrive: { chunk_size: '64M' } }
const pin = (name: string, value: unknown) =>
    expect(JSON.stringify(value, null, 2)).toMatchFileSnapshot(
        `./__snapshots__/requests/${name}.json`
    )

test('copy and move: folders and a file, filters, overrides', async () => {
    const args = {
        sources: ['/tmp/photos/', 'gdrive:albums/'],
        destination: 'e2e-memory:backup/',
        options: {
            copy: { ignore_existing: true },
            config: { transfers: 4 },
            filter: { exclude: ['*.tmp'] },
            metadata: { metadata: true },
            remotes,
        },
    }
    await pin('copy', buildCopyRequests(args))
    await pin(
        'move',
        buildMoveRequests({
            ...args,
            options: { ...args.options, move: { delete_empty_src_dirs: true } },
        })
    )
    // A file source without filters takes the single-file endpoint.
    await pin(
        'copy-file',
        buildCopyRequests({
            sources: ['/tmp/one.txt', '/tmp/photos/'],
            destination: 'gdrive:in/',
            options: { config: {}, remotes },
        })
    )
    // The slash after the colon is the user's: kept on the fs (absolute on sftp, the machine's
    // `/var/www`), absent when absent (under the login directory). A bare root is a folder
    // either way, and is sent as the root, not as a file with no name.
    await pin(
        'copy-slash',
        buildCopyRequests({
            sources: ['sftp:/var/www/', 'sftp:var/www/', 'sftp:', 'sftp:/'],
            destination: 'gdrive:in',
            options: { config: {}, remotes },
        })
    )
})

test('sync and bisync: two paths, the outer switches', async () => {
    const options = {
        sync: { track_renames: true },
        config: { checkers: 2 },
        filter: { max_size: '1G' },
        metadata: {},
        remotes,
    }
    await pin(
        'sync',
        buildSyncRequests({ source: '/tmp/photos/', destination: 'gdrive:backup', options })
    )
    await pin(
        'bisync',
        buildBisyncRequests({
            source: '/tmp/photos/',
            destination: 'gdrive:backup',
            options: {
                ...options,
                bisync: { conflict_resolve: 'newer' },
                outer: { resync: true, force: false },
            },
        })
    )
})

test('delete and purge: folders and a file, config only for purge', async () => {
    await pin(
        'delete',
        buildDeleteRequests({
            sources: ['/tmp/old/', 'gdrive:trash/'],
            options: { filter: { min_age: '7d' }, config: { dry_run: true }, remotes },
        })
    )
    await pin(
        'delete-file',
        buildDeleteRequests({ sources: ['/tmp/one.txt'], options: { config: {} } })
    )
    await pin(
        'purge',
        buildPurgeRequests({
            sources: ['/tmp/old/'],
            options: { config: { transfers: 1 }, remotes },
        })
    )
    expect(() => buildPurgeRequests({ sources: ['/tmp/one.txt'], options: {} })).toThrow(/folders/)
})

test('whether a source is a file or a folder is rclone’s answer, not the slash', async () => {
    // A trailing slash is one way of spelling a path, and the file panel used to add it to every
    // folder so the builders could tell. They cannot from a typed path: `gdrive:folder` is a
    // folder without it, `gdrive:file.txt/` a file with it, and rclone accepts both spellings.
    // The start asks rclone once (`operations/stat`, which every start already did to say
    // "does not exist") and hands the builders its answer.
    const kinds: Kinds = { 'gdrive:folder': 'folder', 'gdrive:file.txt/': 'file' }
    const [copy] = buildCopyRequests(
        {
            sources: ['gdrive:folder', 'gdrive:file.txt/'],
            destination: 'e2e-memory:in',
            options: {},
        },
        kinds
    )
    expect((copy.body as { inputs: unknown[] }).inputs).toEqual([
        {
            _path: 'sync/copy',
            srcFs: 'gdrive:folder/',
            dstFs: 'e2e-memory:in/folder',
            createEmptySrcDirs: true,
        },
        {
            _path: 'operations/copyfile',
            srcFs: 'gdrive:',
            srcRemote: 'file.txt',
            dstFs: 'e2e-memory:',
            dstRemote: 'in/file.txt',
        },
    ])
    // Without an answer (a pure build) the spelling is the only hint there is: as before.
    const [hinted] = buildCopyRequests({
        sources: ['gdrive:folder', 'gdrive:folder/'],
        destination: 'e2e-memory:in',
        options: {},
    })
    expect((hinted.body as { inputs: { _path: string }[] }).inputs.map((i) => i._path)).toEqual([
        'operations/copyfile',
        'sync/copy',
    ])
    // A file inside a folder that is also a source is the folder's to copy, slash or no slash.
    const [nested] = buildCopyRequests(
        {
            sources: ['gdrive:folder', 'gdrive:folder/inner.txt'],
            destination: 'e2e-memory:in',
            options: {},
        },
        { 'gdrive:folder': 'folder', 'gdrive:folder/inner.txt': 'file' }
    )
    expect((nested.body as { inputs: unknown[] }).inputs).toHaveLength(1)

    const [del] = buildDeleteRequests(
        { sources: ['gdrive:folder', 'gdrive:file.txt/'], options: {} },
        kinds
    )
    expect((del.body as { inputs: { _path: string }[] }).inputs.map((i) => i._path)).toEqual([
        'operations/delete',
        'operations/deletefile',
    ])
    // Purge takes folders only; a sync needs one on each side. Said by name, not by rclone.
    expect(() =>
        buildPurgeRequests(
            { sources: ['gdrive:file.txt'], options: {} },
            { 'gdrive:file.txt': 'file' }
        )
    ).toThrow('gdrive:file.txt is a file; only folders can be purged')
    expect(
        buildPurgeRequests(
            { sources: ['gdrive:folder'], options: {} },
            { 'gdrive:folder': 'folder' }
        )[0].body
    ).toMatchObject({ inputs: [{ _path: 'operations/purge', fs: 'gdrive:', remote: 'folder' }] })
    expect(() =>
        buildSyncRequests(
            { source: 'gdrive:file.txt', destination: 'e2e-memory:in', options: {} },
            { 'gdrive:file.txt': 'file' }
        )
    ).toThrow('gdrive:file.txt is a file; a sync needs a folder')
    expect(() =>
        buildBisyncRequests(
            { source: 'gdrive:a.txt', destination: 'e2e-memory:b', options: {} },
            { 'gdrive:a.txt': 'file' }
        )
    ).toThrow('gdrive:a.txt is a file; a bisync needs two folders')
    // The stat that answers carries the operation's own `_config`, without a build first.
    const task = {
        operation: 'copy' as const,
        args: {
            sources: ['gdrive:folder'],
            destination: 'e2e-memory:in',
            options: { config: { transfers: 4 }, copy: { ignore_existing: true } },
        },
    }
    expect(configParamOf(task)).toBe(
        (buildCopyRequests(task.args)[0].body as { _config: string })._config
    )
})
