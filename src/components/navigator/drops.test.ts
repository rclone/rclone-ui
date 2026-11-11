import { expect, test } from 'vitest'
import { POSIX, WINDOWS } from '../../../lib/paths'
import { landsOnItself } from './drops'
import type { SelectItem } from './types'

const folder = (path: string): SelectItem => ({ path, type: 'folder' })
const file = (path: string): SelectItem => ({ path, type: 'file' })

// A folder dropped on itself or on a folder below it would be copied into itself, and anything
// dropped on the folder it is already in would be copied onto itself. The panel refuses such a
// drop, and nothing starts.
test('a folder lands on itself in itself, below itself and in its own folder', () => {
    const photos = [folder('/Users/bob/photos')]
    expect(landsOnItself(photos, '/Users/bob/photos', POSIX)).toBe(true)
    expect(landsOnItself(photos, '/Users/bob/photos/2026/may', POSIX)).toBe(true)
    expect(landsOnItself(photos, '/Users/bob', POSIX)).toBe(true)
    expect(landsOnItself(photos, '/Users/bob/', POSIX)).toBe(true)
    expect(landsOnItself([folder('/Users/bob/photos/')], '/Users/bob/photos/', POSIX)).toBe(true)

    // Above its folder, next to it, or in a sibling whose name starts the same way are all
    // valid destinations.
    expect(landsOnItself(photos, '/Users', POSIX)).toBe(false)
    expect(landsOnItself(photos, '/Users/bob/music', POSIX)).toBe(false)
    expect(landsOnItself(photos, '/Users/bob/photos2', POSIX)).toBe(false)
    expect(landsOnItself(photos, '/', POSIX)).toBe(false)
})

test('a file lands on itself only in its own folder', () => {
    const notes = [file('/tmp/a/notes.txt')]
    expect(landsOnItself(notes, '/tmp/a', POSIX)).toBe(true)
    expect(landsOnItself(notes, '/tmp', POSIX)).toBe(false)
    expect(landsOnItself(notes, '/tmp/b', POSIX)).toBe(false)
    expect(landsOnItself([file('/x.txt')], '/', POSIX)).toBe(true)
})

// Rows from Favorites or a search come from several folders. If any one of them would land on
// itself, the drop is refused.
test('one item on itself refuses the whole drop', () => {
    const items = [file('/a/x.txt'), folder('/b/y')]
    expect(landsOnItself(items, '/b', POSIX)).toBe(true)
    expect(landsOnItself(items, '/b/y/z', POSIX)).toBe(true)
    expect(landsOnItself(items, '/c', POSIX)).toBe(false)
    expect(landsOnItself([], '/b', POSIX)).toBe(false)
})

test('a remote is compared by its name, its parameters and its root', () => {
    const docs = [folder('gdrive:work/docs')]
    expect(landsOnItself(docs, 'gdrive:work', POSIX)).toBe(true)
    expect(landsOnItself(docs, 'gdrive:work/docs/old', POSIX)).toBe(true)
    expect(landsOnItself(docs, 'gdrive:work/docs/', POSIX)).toBe(true)
    expect(landsOnItself(docs, 'gdrive:work/docsx', POSIX)).toBe(false)
    // Another remote, the same remote with other parameters, or the local disk are all
    // different places.
    expect(landsOnItself(docs, 'dropbox:work', POSIX)).toBe(false)
    expect(landsOnItself(docs, 'gdrive,shared_with_me:work', POSIX)).toBe(false)
    expect(landsOnItself(docs, '/work', POSIX)).toBe(false)

    // A remote's relative root (``) and the machine's root on sftp (`/`) are different places.
    expect(landsOnItself([file('gdrive:a.txt')], 'gdrive:', POSIX)).toBe(true)
    expect(landsOnItself([file('sftp:/etc/hosts')], 'sftp:/etc', POSIX)).toBe(true)
    expect(landsOnItself([folder('sftp:/etc')], 'sftp:/', POSIX)).toBe(true)
    expect(landsOnItself([folder('sftp:etc')], 'sftp:/', POSIX)).toBe(false)
    expect(landsOnItself([folder('sftp:/etc')], 'sftp:', POSIX)).toBe(false)
})

test('on a Windows host either separator, and a local name in any case, is the same', () => {
    const data = [folder('C:\\Users\\bob\\data')]
    expect(landsOnItself(data, 'C:\\Users\\bob', WINDOWS)).toBe(true)
    expect(landsOnItself(data, 'C:\\Users\\bob\\data\\2026', WINDOWS)).toBe(true)
    expect(landsOnItself(data, 'C:/Users/bob/data/', WINDOWS)).toBe(true)
    expect(landsOnItself(data, 'c:\\users\\BOB\\Data', WINDOWS)).toBe(true)
    expect(landsOnItself(data, 'D:\\Users\\bob', WINDOWS)).toBe(false)
    expect(landsOnItself(data, 'C:\\Users\\bob\\database', WINDOWS)).toBe(false)
    expect(landsOnItself([file('C:\\a.txt')], 'C:\\', WINDOWS)).toBe(true)
    expect(landsOnItself([folder('\\\\nas\\share\\x')], '\\\\nas\\share', WINDOWS)).toBe(true)
    expect(landsOnItself([folder('r:a\\b')], 'r:a/b/c', WINDOWS)).toBe(true)

    // On other hosts, a backslash is part of a name: `odd\name` is one folder, not `name` in
    // `odd`.
    expect(landsOnItself([folder('/tmp/odd\\name')], '/tmp/odd', POSIX)).toBe(false)
    expect(landsOnItself([folder('/tmp/odd')], '/tmp/odd\\name', POSIX)).toBe(false)
})
