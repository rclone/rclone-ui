import { describe, expect, it } from 'vitest'
import { isDrive, mountPointOf, suggestedMountPoint, tildePath } from './mountPoint'

describe('suggestedMountPoint', () => {
    it('is a folder named after the remote in ~/Rclone', () => {
        expect(suggestedMountPoint('gdrive', '/Users/me', false)).toBe('/Users/me/Rclone/gdrive')
        expect(suggestedMountPoint('gdrive', '/home/me/', false)).toBe('/home/me/Rclone/gdrive')
    })

    it('is none on Windows, or without a home', () => {
        expect(suggestedMountPoint('gdrive', 'C:\\Users\\me', true)).toBeUndefined()
        expect(suggestedMountPoint('gdrive', '', false)).toBeUndefined()
    })
})

describe('mountPointOf', () => {
    it('takes the one typed, else the suggestion', () => {
        expect(mountPointOf(undefined, '/Users/me/Rclone/gdrive', false)).toBe(
            '/Users/me/Rclone/gdrive'
        )
        expect(mountPointOf('/Volumes/g', '/Users/me/Rclone/gdrive', false)).toBe('/Volumes/g')
        // Cleared by the user: no mount point, so the page asks for one.
        expect(mountPointOf('', '/Users/me/Rclone/gdrive', false)).toBe('')
    })

    it('takes the next free drive letter on Windows when none is typed', () => {
        expect(mountPointOf(undefined, undefined, true)).toBe('*')
        expect(mountPointOf('', undefined, true)).toBe('*')
        expect(mountPointOf('M:', undefined, true)).toBe('M:')
    })
})

describe('isDrive', () => {
    it('is a letter, or the next free one, on Windows', () => {
        expect(isDrive('M:', true)).toBe(true)
        expect(isDrive('m:', true)).toBe(true)
        expect(isDrive('*', true)).toBe(true)
    })

    it('is no folder, and nothing elsewhere', () => {
        expect(isDrive('M:\\Rclone', true)).toBe(false)
        expect(isDrive('C:\\Users\\me\\gdrive', true)).toBe(false)
        expect(isDrive('MM:', true)).toBe(false)
        expect(isDrive('M:', false)).toBe(false)
        expect(isDrive('*', false)).toBe(false)
    })
})

describe('tildePath', () => {
    it('reads a path under the home folder from ~', () => {
        expect(tildePath('/Users/me/Rclone/gdrive', '/Users/me')).toBe('~/Rclone/gdrive')
        expect(tildePath('/Users/me', '/Users/me/')).toBe('~')
    })

    it('keeps any other path as it is', () => {
        expect(tildePath('/Users/meg/x', '/Users/me')).toBe('/Users/meg/x')
        expect(tildePath('/Volumes/g', '')).toBe('/Volumes/g')
        expect(tildePath('C:\\Users\\me\\x', 'C:\\Users\\me')).toBe('C:\\Users\\me\\x')
    })
})
