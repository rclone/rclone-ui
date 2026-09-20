import { expect, test } from 'vitest'
import { POSIX, WINDOWS } from '@/lib/paths'
import {
    isListingUnder,
    listingKey,
    listingOf,
    normalizeListingDir,
    parentListingOf,
} from './listingKey'

// Every directory listing the panels cache is named by these; a key that differs by a slash
// would be a second listing of the same folder, and one that matches too widely would drop a
// neighbour's rows on an unrelated change.

test('a directory is one key whatever slash it came with, and a root stays a root', () => {
    const cases: [string, string, typeof POSIX][] = [
        ['', '', POSIX],
        ['/', '/', POSIX],
        ['//', '/', POSIX],
        ['/a/b/', '/a/b', POSIX],
        ['a/b/', 'a/b', POSIX],
        ['a', 'a', POSIX],
        ['/tmp/x', '/tmp/x', POSIX],
        ['C:', 'C:\\', WINDOWS],
        ['C:\\', 'C:\\', WINDOWS],
        ['C:/', 'C:\\', WINDOWS],
        ['C:\\Users\\', 'C:\\Users', WINDOWS],
    ]
    for (const [dir, expected, host] of cases) {
        expect(normalizeListingDir(dir, host), JSON.stringify(dir)).toBe(expected)
        expect(listingKey('r', dir, host), JSON.stringify(dir)).toEqual(['listing', 'r', expected])
    }
})

test('a full path names the listing it is, and the listing that holds it', () => {
    const cases: [string, [string, string], [string, string], typeof POSIX][] = [
        // path, the listing it is, the listing containing it
        ['r:a/b', ['r', 'a/b'], ['r', 'a'], POSIX],
        ['r:a', ['r', 'a'], ['r', ''], POSIX],
        ['r:', ['r', ''], ['r', ''], POSIX],
        ['r:/', ['r', '/'], ['r', '/'], POSIX],
        ['r:/a/b', ['r', '/a/b'], ['r', '/a'], POSIX],
        ['r:/a', ['r', '/a'], ['r', '/'], POSIX],
        ['r:a/b/', ['r', 'a/b'], ['r', 'a'], POSIX],
        ['/tmp/x', ['UI_LOCAL_FS', '/tmp/x'], ['UI_LOCAL_FS', '/tmp'], POSIX],
        ['/x', ['UI_LOCAL_FS', '/x'], ['UI_LOCAL_FS', '/'], POSIX],
        ['/', ['UI_LOCAL_FS', '/'], ['UI_LOCAL_FS', '/'], POSIX],
        ['C:\\a', ['UI_LOCAL_FS', 'C:\\a'], ['UI_LOCAL_FS', 'C:\\'], WINDOWS],
        ['C:\\a\\b\\', ['UI_LOCAL_FS', 'C:\\a\\b'], ['UI_LOCAL_FS', 'C:\\a'], WINDOWS],
        ['C:\\', ['UI_LOCAL_FS', 'C:\\'], ['UI_LOCAL_FS', 'C:\\'], WINDOWS],
    ]
    for (const [path, is, parent, host] of cases) {
        expect(listingOf(path, host), path).toEqual({ remote: is[0], dir: is[1] })
        expect(parentListingOf(path, host), path).toEqual({ remote: parent[0], dir: parent[1] })
    }
})

test('a folder covers its own listing and those below it, never a neighbour with the same start', () => {
    const under: [readonly unknown[], string, string][] = [
        [['listing', 'r', 'a'], 'r', 'a'],
        [['listing', 'r', 'a/b'], 'r', 'a'],
        [['listing', 'r', 'a/b/c'], 'r', 'a/b'],
        [['listing', 'r', 'a'], 'r', ''],
        [['listing', 'r', '/a'], 'r', '/'],
        [['listing', 'UI_LOCAL_FS', '/tmp/x/y'], 'UI_LOCAL_FS', '/tmp/x'],
        [['listing', 'UI_LOCAL_FS', '/tmp/x'], 'UI_LOCAL_FS', '/tmp/x/'],
        [['listing', 'UI_LOCAL_FS', '/tmp'], 'UI_LOCAL_FS', '/'],
    ]
    for (const [key, remote, dir] of under) {
        expect(isListingUnder(key, remote, dir, POSIX), `${key[2]} under ${dir}`).toBe(true)
    }
    expect(
        isListingUnder(['listing', 'UI_LOCAL_FS', 'C:\\a\\b'], 'UI_LOCAL_FS', 'C:\\a', WINDOWS)
    ).toBe(true)
    expect(isListingUnder(['listing', 'UI_LOCAL_FS', 'C:\\a'], 'UI_LOCAL_FS', 'C:', WINDOWS)).toBe(
        true
    )

    const apart: [readonly unknown[], string, string][] = [
        [['listing', 'r', 'ab'], 'r', 'a'],
        [['listing', 'r', 'a'], 'r', 'a/b'],
        [['listing', 'UI_LOCAL_FS', '/tmp/xy'], 'UI_LOCAL_FS', '/tmp/x'],
        [['listing', 'other', 'a/b'], 'r', 'a'],
        [['listing', 'r', 'a'], 'UI_LOCAL_FS', 'a'],
        [['remotes', 'list', 'all'], 'r', ''],
        [['listing', 'r'], 'r', ''],
    ]
    for (const [key, remote, dir] of apart) {
        expect(isListingUnder(key, remote, dir, POSIX), `${String(key[2])} apart from ${dir}`).toBe(
            false
        )
    }
})
