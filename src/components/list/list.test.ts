import { describe, expect, it } from 'vitest'
import { matchAny } from './list'

interface Thing {
    id: string
    name: string
    path: string
}

const THINGS: Thing[] = [
    { id: '1', name: 'Photos', path: 'gdrive:Pictures' },
    { id: '2', name: 'Docs', path: '/Users/me/Documents' },
    { id: '3', name: 'Music', path: 's3:audio' },
]

const fields = (t: Thing) => [t.name, t.path]

describe('matchAny', () => {
    it('finds the search in any field, ignoring case', () => {
        expect(matchAny(THINGS, 'PHOTOS', fields).map((t) => t.id)).toEqual(['1'])
        expect(matchAny(THINGS, 'documents', fields).map((t) => t.id)).toEqual(['2'])
        // "Pictures" is the path of one, and "Music" the name of the other.
        expect(matchAny(THINGS, 'ic', fields).map((t) => t.id)).toEqual(['1', '3'])
    })

    it('ignores the spaces around the search', () => {
        expect(matchAny(THINGS, '  s3:  ', fields).map((t) => t.id)).toEqual(['3'])
    })

    it('keeps every item, in order, for a blank search', () => {
        expect(matchAny(THINGS, '', fields)).toEqual(THINGS)
        expect(matchAny(THINGS, '   ', fields)).toEqual(THINGS)
    })

    it('returns a new list, so the caller can change it', () => {
        expect(matchAny(THINGS, '', fields)).not.toBe(THINGS)
    })

    it('finds nothing when no field has the search', () => {
        expect(matchAny(THINGS, 'videos', fields)).toEqual([])
    })
})
