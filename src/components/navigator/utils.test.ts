import { expect, test } from 'vitest'
import { POSIX, WINDOWS } from '../../../lib/paths'
import {
    expandHome,
    favoriteRows,
    formatModTime,
    getDiskIcon,
    isInLocalFolder,
    newFolderPath,
    panelFolder,
    placeOf,
    shouldShowDisk,
    unknownRemote,
} from './utils'

test('a panel folder is the path the core reads, or none', () => {
    expect(panelFolder('UI_FAVORITES', '')).toBeNull()
    expect(panelFolder(null, '')).toBeNull()
    expect(panelFolder('UI_LOCAL_FS', '')).toBeNull()
    expect(panelFolder('UI_LOCAL_FS', '/tmp')).toBe('/tmp')
    expect(panelFolder('sftp', '/')).toBe('sftp:/')
    expect(panelFolder('gdrive', '')).toBe('gdrive:')
})

test('a path is the place a panel goes to', () => {
    expect(placeOf('sftp:/', POSIX)).toEqual({ remote: 'sftp', cwd: '/' })
    expect(placeOf('sftp:/var/', POSIX)).toEqual({ remote: 'sftp', cwd: '/var' })
    expect(placeOf('sftp:', POSIX)).toEqual({ remote: 'sftp', cwd: '' })
    expect(placeOf('gdrive,shared_with_me:dir/', POSIX)).toEqual({
        remote: 'gdrive,shared_with_me',
        cwd: 'dir',
    })
    expect(placeOf('/tmp/x', POSIX)).toEqual({ remote: 'UI_LOCAL_FS', cwd: '/tmp/x' })
})

test('a new folder goes in the folder shown, at a root too', () => {
    expect(newFolderPath('UI_LOCAL_FS', '/', 'New Folder', POSIX)).toBe('/New Folder')
    expect(newFolderPath('UI_LOCAL_FS', '/tmp/', 'New Folder', POSIX)).toBe('/tmp/New Folder')
    expect(newFolderPath('UI_LOCAL_FS', 'C:\\', 'New Folder', WINDOWS)).toBe('C:\\New Folder')
    expect(newFolderPath('UI_LOCAL_FS', '\\\\nas\\share', 'New Folder', WINDOWS)).toBe(
        '\\\\nas\\share\\New Folder'
    )
    expect(newFolderPath('sftp', '/', 'New Folder', POSIX)).toBe('sftp:/New Folder')
    expect(newFolderPath('sftp', '', 'New Folder', POSIX)).toBe('sftp:New Folder')
    expect(newFolderPath('gdrive,shared_with_me', 'a', 'b', POSIX)).toBe(
        'gdrive,shared_with_me:a/b'
    )
    expect(newFolderPath('UI_FAVORITES', '', 'x', POSIX)).toBeNull()
    expect(newFolderPath('UI_LOCAL_FS', '', 'x', POSIX)).toBeNull()
})

test('a local path is in a folder only below a separator', () => {
    expect(isInLocalFolder('/Users/bob', '/Users/bob', POSIX)).toBe(true)
    expect(isInLocalFolder('/Users/bob/Desktop', '/Users/bob', POSIX)).toBe(true)
    expect(isInLocalFolder('/Users/bobby', '/Users/bob', POSIX)).toBe(false)
    expect(isInLocalFolder('/Users/bob', '/', POSIX)).toBe(true)
    expect(isInLocalFolder('/Users/bob\\x', '/Users/bob', POSIX)).toBe(false)
    expect(isInLocalFolder('C:\\Users\\bob', 'C:\\', WINDOWS)).toBe(true)
    expect(isInLocalFolder('C:\\Users\\bob\\x', 'C:\\Users\\bob', WINDOWS)).toBe(true)
    expect(isInLocalFolder('C:\\Users\\bobby', 'C:\\Users\\bob', WINDOWS)).toBe(false)
    expect(isInLocalFolder('D:\\x', 'C:\\', WINDOWS)).toBe(false)
})

test('a row’s date is a date, or a dash when it can’t be read', () => {
    expect(formatModTime(undefined)).toBe('—')
    expect(formatModTime('2026-01-15T10:00:00.000Z')).toBe(
        new Date('2026-01-15T10:00:00.000Z').toLocaleDateString('en', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        })
    )
    expect(formatModTime('Added on 15/01/2026, 10:00:00')).toBe('—')
})

test('~ stands for the home folder', () => {
    expect(expandHome('~', '/Users/me')).toBe('/Users/me')
    expect(expandHome('~/Documents', '/Users/me')).toBe('/Users/me/Documents')
    expect(expandHome('~/Documents', '/Users/me/')).toBe('/Users/me/Documents')
    expect(expandHome('~\\Documents', 'C:\\Users\\Me', true)).toBe('C:\\Users\\Me\\Documents')
    expect(expandHome('~bob/x', '/Users/me')).toBe('~bob/x')
    expect(expandHome('~\\x', '/Users/me')).toBe('~\\x')
    expect(expandHome('gdrive:~/x', '/Users/me')).toBe('gdrive:~/x')
    expect(expandHome('/tmp', '/Users/me')).toBe('/tmp')
    expect(expandHome('~/x', '')).toBe('~/x')
})

test('an unknown remote is refused by name', () => {
    const remotes = ['gdrive', 'nas']
    expect(unknownRemote('nope:', remotes, POSIX)).toBe('There is no remote called nope.')
    expect(unknownRemote('nope:a/b', remotes, POSIX)).toBe('There is no remote called nope.')
    expect(unknownRemote('gdrive:a', remotes, POSIX)).toBeUndefined()
    expect(unknownRemote('gdrive,shared_with_me:', remotes, POSIX)).toBeUndefined()
    expect(unknownRemote(':local:/tmp', remotes, POSIX)).toBeUndefined()
    expect(unknownRemote('/tmp', remotes, POSIX)).toBeUndefined()
    expect(unknownRemote('nope:', undefined, POSIX)).toBeUndefined()
    expect(unknownRemote('nope:', [], POSIX)).toBe('There is no remote called nope.')
})

test('a favorite whose path can’t be read shows the path as written', () => {
    const rows = favoriteRows([
        { path: 'gdrive:photos/2024', added: 0 },
        { path: '/Users/me/Documents', added: 1_700_000_000_000 },
        { path: 'a*b:x', added: 0 },
    ])
    expect(rows.map((row) => row.name)).toEqual(['(gdrive) 2024', '(LOCAL) Documents', 'a*b:x'])
})

test('the standard folders are shortcuts with their own icons', () => {
    const folders = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Movies', 'Videos']
    const home = getDiskIcon('/Users/me')
    for (const name of folders) {
        const disk = `/Users/me/${name}`
        expect(shouldShowDisk(disk, ['LOCAL_FS', 'LOCAL_FS_EXTRA'])).toBe(true)
        expect(shouldShowDisk(disk, ['LOCAL_FS'])).toBe(false)
        expect(getDiskIcon(disk).icon).not.toBe(home.icon)
    }
    expect(shouldShowDisk('/Users/me/Projects', ['LOCAL_FS', 'LOCAL_FS_EXTRA'])).toBe(false)
})
