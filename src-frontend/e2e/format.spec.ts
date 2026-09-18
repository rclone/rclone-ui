import { expect, test } from '@playwright/test'
import {
    buildReadablePath,
    getFsInfo,
    getRemoteName,
    joinLocalSegments,
    localRootOf,
    pathsWithRemote,
    separatorForOs,
    renameRemoteIn,
    renameRemoteInArgs,
    toWrappedRemote,
} from '../lib/format'
import { POSIX, WINDOWS } from '../lib/paths'
import { renameConfigSection } from '../lib/rclone/config-text'

// lib/format.ts is pure, so it runs in the test process itself. getFsInfo splits every path the
// pages send to rclone (`fs` + `remote`) on the one grammar (`lib/paths.ts`); a wrong split
// silently targets another file.

test('a colon inside a remote file name stays part of the path', () => {
    const info = getFsInfo('gdrive:notes/meeting 10:30.txt')
    expect(info.root).toBe('gdrive:')
    expect(info.filePath).toBe('notes/meeting 10:30.txt')
    expect(info.name).toBe('meeting 10:30.txt')
    expect(info.fullFilePath).toBe('gdrive:notes/meeting 10:30.txt')
})

test('the slash after the colon is the user’s, and the root carries it', () => {
    // `remote:x` and `remote:/x` are two places on sftp (under the login directory; the machine's
    // `/x`) and one place on backends that trim. The app used to strip it; now the root keeps it
    // and everything after is relative to that root, the shape `:local:/` has always had.
    expect(getFsInfo('sftp:var/www/')).toMatchObject({
        root: 'sftp:',
        filePath: 'var/www',
        dirPath: 'var/www/',
        fullDirPath: 'sftp:var/www/',
        type: 'folder',
    })
    expect(getFsInfo('sftp:/var/www/')).toMatchObject({
        root: 'sftp:/',
        filePath: 'var/www',
        fullDirPath: 'sftp:/var/www/',
        fullFilePath: 'sftp:/var/www',
        type: 'folder',
    })
    // A bare root is a folder, either way, and gets no slash it did not have.
    expect(getFsInfo('sftp:')).toMatchObject({
        root: 'sftp:',
        filePath: '',
        dirPath: '',
        fullDirPath: 'sftp:',
        type: 'folder',
    })
    expect(getFsInfo('sftp:/')).toMatchObject({
        root: 'sftp:/',
        filePath: '',
        fullDirPath: 'sftp:/',
        type: 'folder',
    })
    // A local root is explicit, so no caller has to promote a bare `:local:`.
    expect(getFsInfo('/tmp/x/')).toMatchObject({
        root: ':local:/',
        filePath: 'tmp/x',
        fullDirPath: ':local:/tmp/x/',
    })
    expect(getFsInfo('/')).toMatchObject({
        root: ':local:/',
        filePath: '',
        fullDirPath: ':local:/',
        type: 'folder',
    })
    // Whatever the panel wrote: the `:local:` spelling parses to the same thing.
    expect(getFsInfo(':local:/tmp/x/')).toMatchObject({ root: ':local:/', filePath: 'tmp/x' })
    // What rclone would refuse names no remote.
    expect(getRemoteName('-bad:x')).toBeNull()
    expect(getRemoteName('gdrive:photos')).toBe('gdrive')
    expect(getRemoteName('gdrive,chunk_size="64M":photos')).toBe('gdrive')
    expect(getRemoteName(':sftp,host="a:b":/srv')).toBe(':sftp')
    expect(getRemoteName(':local:/x')).toBe(':local')
})

test('what is shown is what was typed', () => {
    expect(buildReadablePath('gdrive:photos/2024')).toBe('gdrive:photos/2024')
    expect(buildReadablePath('gdrive:/photos/2024')).toBe('gdrive:/photos/2024')
    expect(buildReadablePath('gdrive:')).toBe('gdrive:')
    expect(buildReadablePath('gdrive:a/b/c/d/e')).toBe('gdrive:a/.../d/e')
    expect(buildReadablePath('/Users/me/a/b/c')).toBe('/Users/.../b/c')
    expect(buildReadablePath('gdrive:a/b/c.txt', 'short')).toBe('c.txt')
})

test('a local path containing a colon is not mistaken for a remote', () => {
    expect(getRemoteName('/Users/me/Backups/2024-01-01 10:30/')).toBeNull()
    const info = getFsInfo('/Users/me/Backups/2024-01-01 10:30/')
    expect(info.isRemote).toBe(false)
    expect(info.root).toBe(':local:/')
    expect(info.filePath).toBe('Users/me/Backups/2024-01-01 10:30')
    expect(info.type).toBe('folder')
})

test('remote roots and windows drives still resolve', () => {
    expect(getRemoteName('gdrive:')).toBe('gdrive')
    expect(getFsInfo('gdrive:').root).toBe('gdrive:')
    // A drive is a drive on a Windows host. On any other it is what rclone makes of it there:
    // a remote called C (which `pathProblem` reports before it is sent).
    expect(getRemoteName('C:\\Users\\me', WINDOWS)).toBeNull()
    expect(getFsInfo('C:\\Users\\me\\file.txt', WINDOWS).root).toBe(':local:C:/')
    expect(getFsInfo('C:\\Users\\me\\file.txt', WINDOWS).filePath).toBe('Users/me/file.txt')
    expect(getFsInfo('C:\\Users\\me\\file.txt', WINDOWS).fullDirPath).toBe(
        ':local:C:/Users/me/file.txt/'
    )
    expect(getFsInfo('C:', WINDOWS)).toMatchObject({
        root: ':local:C:/',
        filePath: '',
        type: 'folder',
    })
    expect(getRemoteName('C:\\Users\\me', POSIX)).toBe('C')
    // A one-letter remote is a remote everywhere but Windows, where it is a drive.
    expect(getRemoteName('c:photos', POSIX)).toBe('c')
    expect(getRemoteName('c:photos', WINDOWS)).toBeNull()
})

test("a picked path becomes a wrapper backend's remote value", () => {
    // The file panel hands over the path as browsed; only a trailing separator goes. A leading
    // slash is the user's (absolute on sftp) and stays. Local folders keep their absolute form.
    expect(toWrappedRemote('gdrive:/')).toBe('gdrive:/')
    expect(toWrappedRemote('gdrive:')).toBe('gdrive:')
    expect(toWrappedRemote('gdrive:photos/2024/')).toBe('gdrive:photos/2024')
    expect(toWrappedRemote('sftp:/backups/')).toBe('sftp:/backups')
    expect(toWrappedRemote('/Users/me/vault/')).toBe('/Users/me/vault')
    expect(toWrappedRemote('/')).toBe('/')
    expect(toWrappedRemote('C:\\', WINDOWS)).toBe('C:\\')
    expect(toWrappedRemote('C:\\data\\', WINDOWS)).toBe('C:\\data')
})

test('breadcrumb segments rebuild a local path with the host separator', () => {
    // The path bar splits `C:\\Users\\me` into C:, Users, me; a click has to put the drive back
    // in front, not a slash (`/C:/Users` lists nothing on Windows).
    expect(joinLocalSegments(['C:'], '\\')).toBe('C:\\')
    expect(joinLocalSegments(['C:', 'Users', 'me'], '\\')).toBe('C:\\Users\\me')
    expect(joinLocalSegments(['tmp', 'x'], '/')).toBe('/tmp/x')
    expect(joinLocalSegments([], '/')).toBe('/')
    // The Local button: the drive's root on Windows, the root everywhere else.
    expect(localRootOf(['C:', 'Users', 'me'], '\\')).toBe('C:\\')
    expect(localRootOf(['tmp', 'x'], '/')).toBe('/')
})

test('renaming a remote rewrites the paths and per-remote options that name it', () => {
    expect(renameRemoteIn('old:photos/2024', 'old', 'new')).toBe('new:photos/2024')
    expect(renameRemoteIn('old:', 'old', 'new')).toBe('new:')
    // Another remote that merely starts the same way, and a local path holding a colon, stay.
    expect(renameRemoteIn('older:x', 'old', 'new')).toBe('older:x')
    expect(renameRemoteIn('/tmp/old:x', 'old', 'new')).toBe('/tmp/old:x')
    const copy = {
        sources: ['old:a', '/tmp/in'],
        destination: 'old:b',
        options: { config: { transfers: 4 }, remotes: { old: { chunk_size: '8M' }, other: {} } },
    }
    const renamed = renameRemoteInArgs(copy, 'old', 'new')
    expect(renamed.changed).toBe(true)
    expect(renamed.args).toEqual({
        sources: ['new:a', '/tmp/in'],
        destination: 'new:b',
        options: { config: { transfers: 4 }, remotes: { other: {}, new: { chunk_size: '8M' } } },
    })
    // The input is left alone, and an untouched task is handed back as it was.
    expect(copy.sources[0]).toBe('old:a')
    const sync = { source: '/tmp/a', destination: 'gdrive:b', options: {} }
    expect(renameRemoteInArgs(sync, 'old', 'new')).toEqual({ args: sync, changed: false })
})

test('renaming a config section touches only its header line', () => {
    const text = '# comment\n[old]\ntype = memory\n\n[other]\ntype = memory\nnote = [old]\n'
    expect(renameConfigSection(text, 'old', 'new')).toBe(
        '# comment\n[new]\ntype = memory\n\n[other]\ntype = memory\nnote = [old]\n'
    )
    // Windows line endings and padding around the header survive.
    expect(renameConfigSection('[old]  \r\ntype = memory\r\n', 'old', 'new')).toBe(
        '[new]  \r\ntype = memory\r\n'
    )
    expect(() => renameConfigSection(text, 'missing', 'new')).toThrow('no section called missing')
    expect(() => renameConfigSection(text, 'old', 'other')).toThrow(
        'already has a section called other'
    )
})

// The separator belongs to the host the daemon runs on, not to the machine serving the page: a
// Windows host browsed from a Linux server still gets `C:\\Users`, not `/C:/Users`.
test('the local separator follows the host OS', () => {
    expect(separatorForOs('windows')).toBe('\\')
    expect(separatorForOs('macos')).toBe('/')
    expect(separatorForOs('linux')).toBe('/')
    expect(separatorForOs(undefined)).toBe('/')
})

// The Remotes option section is per-remote backend flags; a pair of local paths names no remote
// and the section it would open is empty. The pages ask this before offering it at all.
test('only the paths that name a remote count towards the Remotes section', () => {
    expect(pathsWithRemote(['/tmp/src', '/tmp/dst'])).toEqual([])
    // A drive is local on a Windows host; on any other it is a path the field is refusing.
    expect(pathsWithRemote(['C:\\src', 'C:\\dst'], WINDOWS)).toEqual([])
    expect(pathsWithRemote(['C:\\src', 'C:\\dst'], POSIX)).toEqual([])
    expect(pathsWithRemote(['-bad:x'])).toEqual([])
    expect(pathsWithRemote(['gdrive:photos', '/tmp/dst', undefined])).toEqual(['gdrive:photos'])
    // The local backend spelled as a remote is still local: it has no configured options.
    expect(pathsWithRemote([':local:/tmp/src'])).toEqual([])
    // Duplicates stay — the section reduces them to one tab per name itself.
    expect(pathsWithRemote(['gdrive:a', 'gdrive:b'])).toEqual(['gdrive:a', 'gdrive:b'])
})
