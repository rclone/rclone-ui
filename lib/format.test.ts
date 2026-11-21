import { expect, test } from 'vitest'
import { buildReadablePath, formatBytes, getRemoteName, timeAgo } from './format'
import { POSIX, WINDOWS } from './paths'

test('a path names its remote, and only its remote', () => {
    expect(getRemoteName('gdrive:photos')).toBe('gdrive')
    // A colon inside a remote file name stays part of the path.
    expect(getRemoteName('gdrive:notes/meeting 10:30.txt')).toBe('gdrive')
    // The slash after the colon belongs to the path, not to the name.
    expect(getRemoteName('sftp:/var/www/')).toBe('sftp')
    expect(getRemoteName('gdrive,chunk_size="64M":photos')).toBe('gdrive')
    expect(getRemoteName(':sftp,host="a:b":/srv')).toBe(':sftp')
    // The `:local:` spelling, which a panel may write, is the local backend written as a remote.
    expect(getRemoteName(':local:/x')).toBe(':local')
    // A name that rclone would refuse is not a remote.
    expect(getRemoteName('-bad:x')).toBeNull()
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
    expect(getRemoteName('/')).toBeNull()
})

test('remote roots and windows drives still resolve', () => {
    expect(getRemoteName('gdrive:')).toBe('gdrive')
    // On a Windows host, a drive letter is a drive. On other hosts rclone reads it as a remote
    // called C, which `pathProblem` reports before the path is sent.
    expect(getRemoteName('C:\\Users\\me', WINDOWS)).toBeNull()
    expect(getRemoteName('C:', WINDOWS)).toBeNull()
    expect(getRemoteName('C:\\Users\\me', POSIX)).toBe('C')
    // A one-letter name is a remote everywhere except Windows, where it is a drive.
    expect(getRemoteName('c:photos', POSIX)).toBe('c')
    expect(getRemoteName('c:photos', WINDOWS)).toBeNull()
})

// Without the third argument, one unit, rounded. With it, two units, cut.
test('how long ago a moment is', () => {
    const now = Date.parse('2026-09-23T19:42:39Z')
    const before = (ms: number) => new Date(now - ms).toISOString()
    expect(timeAgo(now - 20_000, now)).toBe('less than a minute ago')
    expect(timeAgo(now + 20_000, now)).toBe('in less than a minute')
    expect(timeAgo(now - 40_000, now)).toBe('1 minute ago')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago')
    // A time 5 minutes ahead, read a second later, is still in 5 minutes.
    expect(timeAgo(now + 5 * 60_000 - 1000, now)).toBe('in 5 minutes')
    expect(timeAgo(now - 59 * 60_000 - 50_000, now)).toBe('1 hour ago')
    expect(timeAgo(now + 3 * 3_600_000, now)).toBe('in 3 hours')
    expect(timeAgo(now - 13 * 3_600_000, now)).toBe('13 hours ago')
    expect(timeAgo(new Date(now - 3 * 86_400_000), now)).toBe('3 days ago')
    expect(timeAgo(before(3_600_000 + 5 * 60_000 + 10_000), now, true)).toBe(
        '1 hour, 5 minutes ago'
    )
    expect(timeAgo(before(2 * 86_400_000 + 3 * 3_600_000 + 7_000), now, true)).toBe(
        '2 days, 3 hours ago'
    )
    expect(timeAgo(before(3_600_000), now, true)).toBe('1 hour ago')
    expect(timeAgo(before(500), now, true)).toBe('just now')
    expect(timeAgo(before(-90_000), now, true)).toBe('in 1 minute, 30 seconds')
    expect(timeAgo('not a time', now)).toBe('')
})

test('sizes go up to petabytes, so a whole disk or remote reads well', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 TB')
    expect(formatBytes(2.25 * 1024 ** 5)).toBe('2.25 PB')
})
