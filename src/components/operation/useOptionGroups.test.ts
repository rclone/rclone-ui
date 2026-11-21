import { describe, expect, it } from 'vitest'
import {
    mergeTemplate,
    parseGroups,
    parseRemotes,
    remoteNamesOf,
    textsEdited,
} from './useOptionGroups'

describe('parseGroups', () => {
    it('names every invalid group, in order, and parses the others', () => {
        const keys = ['copy', 'filter', 'config'] as const
        expect(
            parseGroups(keys, { copy: '{"transfers": 4}', filter: '{"include": [', config: 'x' })
        ).toEqual({ options: { copy: { transfers: 4 } }, invalid: ['filter', 'config'] })
        expect(
            parseGroups(keys, { copy: '{}', filter: '{"exclude": ["*.tmp"]}', config: '{}' })
        ).toEqual({
            options: { copy: {}, filter: { exclude: ['*.tmp'] }, config: {} },
            invalid: [],
        })
    })

    it('refuses non-objects', () => {
        for (const text of ['null', '[]', '5', '"x"', 'true']) {
            expect(parseGroups(['config'], { config: text })).toEqual({
                options: {},
                invalid: ['config'],
            })
        }
    })
})

describe('mergeTemplate', () => {
    const keys = ['copy', 'filter', 'config'] as const
    const current = {
        copy: { checksum: true },
        filter: { exclude: ['*.tmp'] },
        config: { transfers: 4, retries: 3 },
    }

    it("spreads the template's groups over the current options", () => {
        expect(
            mergeTemplate(keys, current, {
                config: { transfers: 8, checkers: 16 },
                filter: { include: ['*.jpg'] },
            })
        ).toEqual({
            filter: { exclude: ['*.tmp'], include: ['*.jpg'] },
            config: { transfers: 8, retries: 3, checkers: 16 },
        })
    })

    it('removes the options that the template sets to null', () => {
        expect(mergeTemplate(keys, current, { config: { retries: null } })).toEqual({
            config: { transfers: 4 },
        })
    })

    it('leaves out the groups that the template has no options for', () => {
        expect(mergeTemplate(keys, current, { copy: null, mount: { x: 1 } } as never)).toEqual({})
    })
})

describe('parseRemotes', () => {
    it('reads only selected remotes', () => {
        const json = { gdrive: '{"chunk_size": "64M"}', old: '{"nope": 1}', broken: '{' }
        expect(parseRemotes(['gdrive', 's3'], json)).toEqual({
            options: { gdrive: { chunk_size: '64M' }, s3: {} },
        })
        expect(parseRemotes([], json)).toEqual({ options: {} })
    })

    it('names an invalid selected tab', () => {
        expect(parseRemotes(['s3', 'gdrive'], { s3: '{}', gdrive: '{"a":' })).toEqual({
            invalid: 'gdrive',
        })
        expect(parseRemotes(['s3'], { s3: 'null' })).toEqual({ invalid: 's3' })
    })
})

describe('remoteNamesOf', () => {
    it('dedupes and drops local paths', () => {
        expect(
            remoteNamesOf([
                'gdrive:photos',
                '/Users/me/Pictures',
                undefined,
                '',
                'gdrive:docs',
                's3:bucket/x',
            ])
        ).toEqual(['gdrive', 's3'])
    })

    it('leaves out :local and paths with a problem', () => {
        expect(remoteNamesOf([':local:/tmp/x', 'gdrive,chunk_size="64M:', 'mem:a'])).toEqual([
            'mem',
        ])
    })
})

describe('textsEdited', () => {
    it('is unchanged for the same texts', () => {
        const texts = { copy: '{}', config: '{\n  "transfers": 8\n}' }
        expect(textsEdited(texts, { ...texts })).toBe(false)
        expect(textsEdited({}, {})).toBe(false)
    })

    it('is changed when a text is', () => {
        expect(textsEdited({ copy: '{}' }, { copy: '{"checksum": true}' })).toBe(true)
        // Invalid JSON still counts as an edit.
        expect(textsEdited({ copy: '{}' }, { copy: '{' })).toBe(true)
    })

    it('reads no text and no options alike', () => {
        expect(textsEdited({}, { gdrive: '{}' })).toBe(false)
        expect(textsEdited({ gdrive: '{\n}' }, {})).toBe(false)
        expect(textsEdited({}, { gdrive: '{"chunk_size": "64M"}' })).toBe(true)
        expect(textsEdited({ gdrive: '{"chunk_size": "64M"}' }, {})).toBe(true)
    })
})
