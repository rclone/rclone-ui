import { expect, test } from 'vitest'
import { POSIX, WINDOWS } from '../../../lib/paths'
import { isInside } from './drops'
import {
    addTo,
    alreadySelected,
    folderHolding,
    removeFrom,
    type Selection,
    selectAllOf,
} from './selection'

const sel = (entries: [string, 'file' | 'folder'][]): Selection => new Map(entries)

test('inside means below a folder, at any depth, on the same remote', () => {
    expect(isInside('gdrive:a/b', 'gdrive:a', POSIX)).toBe(true)
    expect(isInside('gdrive:a/b/c.txt', 'gdrive:a', POSIX)).toBe(true)
    expect(isInside('gdrive:a', 'gdrive:a', POSIX)).toBe(false)
    expect(isInside('gdrive:ab', 'gdrive:a', POSIX)).toBe(false)
    expect(isInside('other:a/b', 'gdrive:a', POSIX)).toBe(false)
    expect(isInside('gdrive:a/b', 'gdrive:', POSIX)).toBe(true)
    // The absolute root (`/`) isn't the login folder.
    expect(isInside('sftp:/a/b', 'sftp:a', POSIX)).toBe(false)
    expect(isInside('/Users/me/x', '/Users/me', POSIX)).toBe(true)
    expect(isInside('/Users/me/x', '/', POSIX)).toBe(true)
    expect(isInside('C:\\Users\\Me\\x', 'c:\\users\\me', WINDOWS)).toBe(true)
})

test('an item inside a selected folder is held by it', () => {
    const selection = sel([
        ['gdrive:a', 'folder'],
        ['gdrive:b.txt', 'file'],
    ])
    expect(folderHolding(selection, 'gdrive:a/x.txt', POSIX)).toBe('gdrive:a')
    expect(folderHolding(selection, 'gdrive:a/deep/x.txt', POSIX)).toBe('gdrive:a')
    expect(folderHolding(selection, 'gdrive:a', POSIX)).toBeUndefined()
    expect(folderHolding(selection, 'gdrive:ab/x', POSIX)).toBeUndefined()
    // A file holds nothing.
    expect(folderHolding(selection, 'gdrive:b.txt/x', POSIX)).toBeUndefined()
})

test('selecting a folder unticks what is inside it, and so does unticking it', () => {
    const selection = sel([
        ['gdrive:a/x.txt', 'file'],
        ['gdrive:a/sub', 'folder'],
        ['gdrive:b.txt', 'file'],
    ])
    addTo(selection, { key: 'gdrive:a', isDir: true }, POSIX)
    expect([...selection.keys()]).toEqual(['gdrive:b.txt', 'gdrive:a'])
    // Restored or older selections may still hold items inside a folder.
    selection.set('gdrive:a/y.txt', 'file')
    removeFrom(selection, 'gdrive:a', POSIX)
    expect([...selection.keys()]).toEqual(['gdrive:b.txt'])
    // A file is only itself.
    addTo(selection, { key: 'gdrive:c.txt', isDir: false }, POSIX)
    expect([...selection.keys()]).toEqual(['gdrive:b.txt', 'gdrive:c.txt'])
})

test('select all skips items inside selected folders, and names the folder', () => {
    // A search in subfolders lists a folder and what is inside it side by side.
    const selection = sel([['gdrive:a', 'folder']])
    const { next, holder } = selectAllOf(
        selection,
        [
            { key: 'gdrive:a/x.txt', isDir: false },
            { key: 'gdrive:b/y.txt', isDir: false },
            { key: 'gdrive:b', isDir: true },
            { key: 'gdrive:c.txt', isDir: false },
        ],
        POSIX
    )
    expect(holder).toBe('gdrive:a')
    // gdrive:b/y.txt is inside gdrive:b, which this select all picks too.
    expect([...next.keys()]).toEqual(['gdrive:a', 'gdrive:b', 'gdrive:c.txt'])
    // The selection it started from is left as it was.
    expect([...selection.keys()]).toEqual(['gdrive:a'])
    // Nothing skipped, no toast.
    expect(selectAllOf(new Map(), [{ key: 'gdrive:z', isDir: false }], POSIX).holder).toBe(
        undefined
    )
})

test('the toast names the selected folder', () => {
    expect(alreadySelected('gdrive:photos/2024', POSIX)).toEqual({
        title: 'Already selected',
        description:
            '“2024” is selected, so its contents are included already. Unselect it to choose items inside it.',
    })
})
