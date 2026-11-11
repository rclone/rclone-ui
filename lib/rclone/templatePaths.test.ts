import { describe, expect, it } from 'vitest'
import {
    applyTemplatePaths,
    describeTemplatePaths,
    hasTemplatePaths,
    pathsFromArgs,
} from './templatePaths'

describe('hasTemplatePaths', () => {
    it('needs a source or a destination', () => {
        expect(hasTemplatePaths(undefined)).toBe(false)
        expect(hasTemplatePaths({})).toBe(false)
        expect(hasTemplatePaths({ sources: [], destination: '' })).toBe(false)
        expect(hasTemplatePaths({ sources: ['a:'] })).toBe(true)
        expect(hasTemplatePaths({ destination: 'b:' })).toBe(true)
    })
})

describe('applyTemplatePaths', () => {
    const current = { sources: ['a:x'], destination: 'b:' }

    it('adds the sources the page lacks and keeps its destination on merge', () => {
        expect(
            applyTemplatePaths(current, { sources: ['a:x', 'c:y'], destination: 'd:' }, true)
        ).toEqual({ sources: ['a:x', 'c:y'], destination: 'b:' })
    })

    it('fills an empty destination on merge', () => {
        expect(
            applyTemplatePaths({ sources: ['a:x'] }, { sources: [], destination: 'd:' }, true)
        ).toEqual({ sources: ['a:x'], destination: 'd:' })
        expect(applyTemplatePaths({}, { sources: ['c:y'] }, true)).toEqual({ sources: ['c:y'] })
    })

    it('swaps both on replace', () => {
        expect(
            applyTemplatePaths(current, { sources: ['c:y', 'e:z'], destination: 'd:' }, false)
        ).toEqual({ sources: ['c:y', 'e:z'], destination: 'd:' })
    })

    it('keeps what the template has no value for', () => {
        expect(applyTemplatePaths(current, { destination: 'd:' }, false)).toEqual({
            sources: ['a:x'],
            destination: 'd:',
        })
        expect(applyTemplatePaths(current, { sources: ['c:y'] }, false)).toEqual({
            sources: ['c:y'],
            destination: 'b:',
        })
    })

    it('leaves the page alone for a template without paths', () => {
        expect(applyTemplatePaths(current, undefined, false)).toBe(current)
        expect(applyTemplatePaths(current, { sources: [], destination: '' }, false)).toBe(current)
    })
})

describe('describeTemplatePaths', () => {
    it('shows the first source, the count of the others and the destination', () => {
        expect(describeTemplatePaths({ sources: ['a:x', 'a:y', 'a:z'], destination: 'b:' })).toBe(
            'a:x and 2 more → b:'
        )
        expect(describeTemplatePaths({ sources: ['a:x'], destination: 'b:' })).toBe('a:x → b:')
        expect(describeTemplatePaths({ sources: ['a:x'] })).toBe('a:x')
        expect(describeTemplatePaths({ destination: 'b:' })).toBe('b:')
        expect(describeTemplatePaths({})).toBeUndefined()
    })
})

describe('pathsFromArgs', () => {
    it('reads a form with several sources or one', () => {
        expect(pathsFromArgs({ sources: ['a:', 'b:'], destination: 'c:' })).toEqual({
            sources: ['a:', 'b:'],
            destination: 'c:',
        })
        expect(pathsFromArgs({ source: 'a:', destination: '/m' })).toEqual({
            sources: ['a:'],
            destination: '/m',
        })
        expect(pathsFromArgs({ sources: [] })).toEqual({
            sources: undefined,
            destination: undefined,
        })
        expect(pathsFromArgs({ source: '' })).toEqual({
            sources: undefined,
            destination: undefined,
        })
    })
})
