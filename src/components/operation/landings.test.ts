import { describe, expect, it, vi } from 'vitest'
import type { Operations } from '../../../lib/core/types'
import { landingLine } from './landings'

vi.mock('../../../lib/core/api', () => ({ transfers: {} }))

const land = (l: Partial<Operations.Landing> & { path: string }): Operations.Landing => ({
    source: '',
    name: l.path.split('/').pop() ?? '',
    folder: false,
    contents: false,
    ...l,
})

describe('landingLine', () => {
    it('says nothing without landings', () => {
        expect(landingLine(undefined, 'gdrive:in')).toBeUndefined()
        expect(landingLine([], 'gdrive:in')).toBeUndefined()
    })

    it('names where one folder or file lands', () => {
        expect(landingLine([land({ path: 'gdrive:in/Photos', folder: true })], 'gdrive:in')).toBe(
            'Lands in gdrive:in/Photos'
        )
        expect(landingLine([land({ path: 'gdrive:in/a.txt' })], 'gdrive:in')).toBe(
            'Lands as gdrive:in/a.txt'
        )
    })

    it("says that a root's contents go straight in", () => {
        expect(
            landingLine(
                [land({ path: 'gdrive:in', name: '', folder: true, contents: true })],
                'gdrive:in'
            )
        ).toBe('Its contents land straight in gdrive:in')
    })

    it('lists several by name, folders with a slash', () => {
        const two = [
            land({ path: 'gdrive:in/Photos', folder: true }),
            land({ path: 'gdrive:in/a.txt' }),
        ]
        expect(landingLine(two, ' gdrive:in ')).toBe('Lands in gdrive:in as Photos/ and a.txt')
        const five = [
            ...two,
            land({ path: 'gdrive:in/Docs', folder: true }),
            land({ path: 'gdrive:in/b.txt' }),
            land({ path: 'gdrive:in/c.txt' }),
        ]
        expect(landingLine(five, 'gdrive:in')).toBe(
            'Lands in gdrive:in as Photos/, a.txt, Docs/ and 2 more'
        )
    })
})
