import { describe, expect, it } from 'vitest'
import { sourceOf, splitSource } from './source'

describe('splitSource', () => {
    it('reads the remote and the folder in it', () => {
        expect(splitSource('gdrive:')).toEqual({ remote: 'gdrive', remotePath: '' })
        expect(splitSource('gdrive:photos')).toEqual({ remote: 'gdrive', remotePath: 'photos' })
        expect(splitSource('gdrive:Photos/2024')).toEqual({
            remote: 'gdrive',
            remotePath: 'Photos/2024',
        })
        expect(splitSource('sftp:/srv')).toEqual({ remote: 'sftp', remotePath: '/srv' })
    })

    it('names no remote for a local path, or one made on the fly', () => {
        expect(splitSource('')).toBeUndefined()
        expect(splitSource('/Users/me')).toBeUndefined()
        expect(splitSource(':s3:bucket')).toBeUndefined()
        expect(splitSource('s3,provider=AWS:bucket')).toBeUndefined()
    })
})

describe('sourceOf', () => {
    it('joins the remote and the folder', () => {
        expect(sourceOf({ remote: 'gdrive', remotePath: '' })).toBe('gdrive:')
        expect(sourceOf({ remote: 'gdrive', remotePath: 'Photos' })).toBe('gdrive:Photos')
    })
})
