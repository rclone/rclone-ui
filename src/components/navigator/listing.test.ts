import { expect, test } from 'vitest'
import type { Browse } from '../../../lib/core/types'
import {
    entryChanged,
    type Held,
    listingError,
    mountChanged,
    onFolderChanged,
    pathWritten,
    relisting,
    toEntries,
    transferEnded,
} from './listing'
import { listingKey } from './listingKey'

// The core owns the listing and each row's full path. These tests cover what the panel does
// with the rows: the display rules, the sizes it adds to local folders, and which panels a
// change refreshes.

const LEAF = /[^/\\]*$/

const row = (path: string, isDir = false, size = 10, below = ''): Browse.Row => ({
    path,
    name: LEAF.exec(path)?.[0] ?? '',
    size,
    modTime: '2026-01-01T00:00:00Z',
    isDir,
    id: '',
    tier: '',
    isBucket: false,
    below,
})

test('a remote folder: each row’s path as it came; dot-files hidden, folders first', () => {
    const entries = toEntries(
        [
            row('gdrive:photos/b.jpg'),
            row('gdrive:photos/.hidden'),
            row('gdrive:photos/a', true, -1),
        ],
        'gdrive'
    )
    expect(entries.map((entry) => [entry.key, entry.fullPath])).toEqual([
        ['gdrive:photos/a', 'gdrive:photos/a'],
        ['gdrive:photos/b.jpg', 'gdrive:photos/b.jpg'],
    ])
    expect(entries[0]).toMatchObject({ isDir: true, name: 'a', remote: 'gdrive' })
    expect(entries[1]).toMatchObject({ size: 10, modTime: '2026-01-01T00:00:00Z' })
    // A size the backend doesn't know (-1) means no size. It isn't shown as "-1 B", and it
    // doesn't count as under any limit.
    expect(entries[0].size).toBeUndefined()
    const unknown = toEntries([row('gdrive:photos/big.pdf', false, -1)], 'gdrive')
    expect(unknown[0].size).toBeUndefined()
    // Under the absolute root, the leading slash is kept, and a bucket is a folder.
    const bucket = { ...row('sftp:/var', false, 0), isBucket: true }
    expect(toEntries([bucket], 'sftp')[0]).toMatchObject({ fullPath: 'sftp:/var', isDir: true })
})

test('a local folder takes its folders’ sizes from the sizes job, by path', () => {
    const sizes = new Map([['/Users/me/docs', 4096]])
    const entries = toEntries(
        [
            row('/Users/me/docs', true, 0),
            row('/Users/me/a.txt', false, 5),
            row('/Users/me/b', false, -1),
        ],
        'UI_LOCAL_FS',
        { sizes }
    )
    expect(entries.map((entry) => [entry.fullPath, entry.size])).toEqual([
        ['/Users/me/docs', 4096],
        ['/Users/me/a.txt', 5],
        ['/Users/me/b', undefined],
    ])
    // On a Windows host, the core writes the paths with the drive and its separator.
    const windows = toEntries(
        [row('C:\\Users\\me\\docs', true), row('C:\\Users\\me\\a.txt')],
        'UI_LOCAL_FS',
        { sizes: new Map([['C:\\Users\\me\\docs', 7]]) }
    )
    expect(windows.map((entry) => [entry.fullPath, entry.name, entry.size])).toEqual([
        ['C:\\Users\\me\\docs', 'docs', 7],
        ['C:\\Users\\me\\a.txt', 'a.txt', 10],
    ])
})

test('a search names its matches by their path below the folder searched', () => {
    const entries = toEntries([row('gdrive:photos/2024/x.jpg', false, 1, '2024/x.jpg')], 'gdrive', {
        search: true,
    })
    expect(entries[0]).toMatchObject({
        fullPath: 'gdrive:photos/2024/x.jpg',
        name: 'x.jpg',
        displayName: '2024/x.jpg',
    })
    // Rows from a listing don't get that name.
    expect(toEntries([row('gdrive:photos/x.jpg')], 'gdrive')[0].displayName).toBeUndefined()
})

test('a change reaches the panels showing the folder it touched', () => {
    const asked: string[] = []
    const panels = [
        listingKey('gdrive', 'photos'),
        listingKey('gdrive', 'photos/2024'),
        listingKey('gdrive', 'photosx'),
        listingKey('UI_LOCAL_FS', '/tmp'),
    ]
    const off = onFolderChanged((changed) => {
        for (const panel of panels) if (changed(panel)) asked.push(`${panel[1]}:${panel[2]}`)
    })
    // A new file changes the folder that holds it.
    entryChanged('gdrive:photos/a.jpg', false)
    expect(asked).toEqual(['gdrive:photos'])
    asked.length = 0
    // A renamed folder changes its parent and everything that was below it.
    entryChanged('gdrive:photos/2024', true)
    expect(asked).toEqual(['gdrive:photos', 'gdrive:photos/2024'])
    asked.length = 0
    // A copy changes its destination and everything below it.
    pathWritten('/tmp')
    expect(asked).toEqual(['UI_LOCAL_FS:/tmp'])
    off()
})

test('a transfer’s end reaches the panels its operation changed', () => {
    const asked: string[] = []
    const panels = [
        listingKey('gdrive', ''),
        listingKey('gdrive', 'b'),
        listingKey('gdrive', 'b/sub'),
        listingKey('UI_LOCAL_FS', '/tmp'),
        listingKey('UI_LOCAL_FS', '/tmp/photos'),
        listingKey('UI_LOCAL_FS', '/tmp/photos/2024'),
    ]
    const off = onFolderChanged((changed) => {
        for (const panel of panels) if (changed(panel)) asked.push(`${panel[1]}:${panel[2]}`)
    })
    const after = (operation: string) => {
        asked.length = 0
        transferEnded(operation, ['/tmp/photos'], 'gdrive:b')
        return [...asked]
    }
    // A sync writes its destination, and may create the folders above it.
    expect(after('sync')).toEqual(['gdrive:', 'gdrive:b', 'gdrive:b/sub'])
    // A bisync writes both of its paths.
    expect(after('bisync')).toEqual([
        'gdrive:',
        'gdrive:b',
        'gdrive:b/sub',
        'UI_LOCAL_FS:/tmp',
        'UI_LOCAL_FS:/tmp/photos',
        'UI_LOCAL_FS:/tmp/photos/2024',
    ])
    // A move also changes the folder that held its source.
    expect(after('move')).toEqual([
        'gdrive:',
        'gdrive:b',
        'gdrive:b/sub',
        'UI_LOCAL_FS:/tmp',
        'UI_LOCAL_FS:/tmp/photos',
        'UI_LOCAL_FS:/tmp/photos/2024',
    ])
    off()
})

// A transfer into a folder that didn't exist creates it, so the panels on every folder above
// the destination list again, and the new folder shows up. Folders beside it, and folders whose
// names only start the same, are left alone.
test('a written path refreshes the panels above it, on it and below it', () => {
    const asked: string[] = []
    const panels = [
        listingKey('UI_LOCAL_FS', '/'),
        listingKey('UI_LOCAL_FS', '/Users'),
        listingKey('UI_LOCAL_FS', '/Users/me'),
        listingKey('UI_LOCAL_FS', '/Users/me/new/deep'),
        listingKey('UI_LOCAL_FS', '/Users/me/new/deep/below'),
        listingKey('UI_LOCAL_FS', '/Users/me/newer'),
        listingKey('UI_LOCAL_FS', '/Users/other'),
        listingKey('gdrive', ''),
    ]
    const off = onFolderChanged((changed) => {
        for (const panel of panels) if (changed(panel)) asked.push(`${panel[1]}:${panel[2]}`)
    })
    pathWritten('/Users/me/new/deep/')
    expect(asked).toEqual([
        'UI_LOCAL_FS:/',
        'UI_LOCAL_FS:/Users',
        'UI_LOCAL_FS:/Users/me',
        'UI_LOCAL_FS:/Users/me/new/deep',
        'UI_LOCAL_FS:/Users/me/new/deep/below',
    ])
    asked.length = 0
    // A download from the Download page names the file it wrote.
    transferEnded('download', ['gdrive:a.txt'], '/Users/me/a.txt')
    expect(asked).toEqual(['UI_LOCAL_FS:/', 'UI_LOCAL_FS:/Users', 'UI_LOCAL_FS:/Users/me'])
    off()
})

// A mount that comes up, fails or goes away changes what its mount point shows, and its parent.
test('a mount’s start or stop refreshes its mount point and the folder above it', () => {
    const asked: string[] = []
    const panels = [
        listingKey('UI_LOCAL_FS', '/Users/me'),
        listingKey('UI_LOCAL_FS', '/Users/me/mnt'),
        listingKey('UI_LOCAL_FS', '/Users/me/mnt/sub'),
        listingKey('UI_LOCAL_FS', '/Users'),
    ]
    const off = onFolderChanged((changed) => {
        for (const panel of panels) if (changed(panel)) asked.push(`${panel[2]}`)
    })
    for (const state of ['running', 'restarting', 'failed', 'stopped']) {
        asked.length = 0
        mountChanged({ state, mountPoint: '/Users/me/mnt' })
        expect(asked).toEqual(['/Users/me', '/Users/me/mnt', '/Users/me/mnt/sub'])
    }
    asked.length = 0
    // Starting isn't ready yet, a Windows drive isn't a folder a panel lists, and an event
    // without a mount point only says that the list of stopped mounts changed.
    mountChanged({ state: 'starting', mountPoint: '/Users/me/mnt' })
    mountChanged({ state: 'running', mountPoint: 'X:' })
    mountChanged({ state: 'running', mountPoint: '*' })
    mountChanged({ state: 'stopped' })
    expect(asked).toEqual([])
    off()
})

// A refresh keeps the rows the panel held in full until the new listing ends. A first listing,
// or a listing of another folder, shows its pieces as they arrive.
test('a refresh holds the rows shown, until the folder is listed again', () => {
    const held: Held<string> = { at: 'gdrive\nphotos', rows: ['a'], complete: true }
    const base = { at: 'gdrive\nphotos', held, current: true, phase: 'running' }
    expect(relisting(base)).toBe(true)
    expect(relisting({ ...base, phase: 'done' })).toBe(false)
    expect(relisting({ ...base, at: 'gdrive\nother' })).toBe(false)
    expect(relisting({ ...base, current: false })).toBe(false)
    expect(relisting({ ...base, held: { ...held, complete: false } })).toBe(false)
    expect(relisting({ ...base, at: null })).toBe(false)
})

test("a failed listing shows rclone's error, unless the core says the folder is missing", () => {
    expect(listingError('permission denied', false)).toBe('permission denied')
    // The core's code decides, not the wording of rclone's message.
    expect(listingError('directory not found', true)).toBe('No access or folder does not exist')
    expect(listingError('bucket does not exist', false)).toBe('bucket does not exist')
    expect(listingError(undefined, false)).toBe('No access or folder does not exist')
})
