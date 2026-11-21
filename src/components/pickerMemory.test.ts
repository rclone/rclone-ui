import { describe, expect, it } from 'vitest'
import { POSIX, WINDOWS } from '../../lib/paths'
import { EVERYWHERE, REMOTES, THIS_MACHINE } from './operation/places'
import { placeToRemember, rememberedStart } from './pickerMemory'

const file = (path: string) => ({ path, type: 'file' as const })
const folder = (path: string) => ({ path, type: 'folder' as const })

describe('placeToRemember', () => {
    it('remembers the folder that the picker showed, for a ticked file or folder', () => {
        expect(placeToRemember([file('/Users/me/docs/a.txt')], '/Users/me/docs', POSIX)).toBe(
            '/Users/me/docs'
        )
        // Not the picked folder itself, so the next picker opens beside it.
        expect(placeToRemember([folder('/Users/me/docs/photos')], '/Users/me/docs', POSIX)).toBe(
            '/Users/me/docs'
        )
        expect(placeToRemember([file('gdrive:a.txt'), folder('gdrive:b')], 'gdrive:', POSIX)).toBe(
            'gdrive:'
        )
    })

    it('remembers the picked folder when it is the one shown (Pick current folder)', () => {
        expect(placeToRemember([folder('gdrive:Photos')], 'gdrive:Photos', POSIX)).toBe(
            'gdrive:Photos'
        )
    })

    it('remembers the folder shown for an item that a search in subfolders found further down', () => {
        expect(placeToRemember([file('gdrive:Photos/2024/a.jpg')], 'gdrive:Photos', POSIX)).toBe(
            'gdrive:Photos'
        )
    })

    it('remembers the folder that the first item is in on Favorites and the list of disks', () => {
        expect(placeToRemember([file('/Users/me/docs/a.txt')], null, POSIX)).toBe('/Users/me/docs')
        expect(placeToRemember([folder('gdrive,shared_with_me:Work/Plans')], null, POSIX)).toBe(
            'gdrive,shared_with_me:Work'
        )
        expect(placeToRemember([folder('sftp:/etc')], null, POSIX)).toBe('sftp:/')
        expect(placeToRemember([folder('gdrive:')], null, POSIX)).toBe('gdrive:')
        expect(placeToRemember([folder('/Volumes/Backup')], null, POSIX)).toBe('/Volumes')
        // A root is its own parent.
        expect(placeToRemember([folder('/')], null, POSIX)).toBe('/')
        expect(placeToRemember([folder('D:\\')], null, WINDOWS)).toBe('D:\\')
        expect(placeToRemember([file('C:\\Users\\me\\a.txt')], null, WINDOWS)).toBe('C:\\Users\\me')
    })

    it('remembers nothing when nothing was picked, or for a bare name, which is in no folder', () => {
        expect(placeToRemember([], '/Users/me', POSIX)).toBeUndefined()
        expect(placeToRemember([file('notes.txt')], null, POSIX)).toBeUndefined()
    })
})

describe('rememberedStart', () => {
    it('starts at the remembered folder when the picker offers that kind of place', () => {
        expect(rememberedStart('/Users/me/docs', undefined, POSIX)).toBe('/Users/me/docs')
        expect(rememberedStart('/Users/me/docs', EVERYWHERE, POSIX)).toBe('/Users/me/docs')
        expect(rememberedStart('/Users/me/docs', THIS_MACHINE, POSIX)).toBe('/Users/me/docs')
        expect(rememberedStart('gdrive:Photos', REMOTES, POSIX)).toBe('gdrive:Photos')
        expect(rememberedStart('C:\\Users\\me', THIS_MACHINE, WINDOWS)).toBe('C:\\Users\\me')
    })

    it("doesn't start in a local folder when the picker offers only remotes, or the reverse", () => {
        expect(rememberedStart('/Users/me/docs', REMOTES, POSIX)).toBeUndefined()
        expect(rememberedStart('C:\\Users\\me', REMOTES, WINDOWS)).toBeUndefined()
        expect(rememberedStart('gdrive:Photos', THIS_MACHINE, POSIX)).toBeUndefined()
    })

    it('starts nowhere in particular when nothing is remembered', () => {
        expect(rememberedStart('', EVERYWHERE, POSIX)).toBeUndefined()
        expect(rememberedStart('', undefined, POSIX)).toBeUndefined()
    })
})
