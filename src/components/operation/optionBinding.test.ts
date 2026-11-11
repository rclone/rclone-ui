import { describe, expect, it } from 'vitest'
import { itemsOf, optionOf, withOption } from './optionBinding'

describe('optionOf', () => {
    it('reads the option from the text', () => {
        expect(optionOf('{"ignore_existing": true}', 'ignore_existing')).toBe(true)
        expect(optionOf('{"exclude": ["*.tmp"]}', 'exclude')).toEqual(['*.tmp'])
        expect(optionOf('{}', 'checksum')).toBeUndefined()
        expect(optionOf('{"checksum": null}', 'checksum')).toBeUndefined()
    })

    it('reads nothing from text that does not read', () => {
        expect(optionOf('{"transfers": 4,', 'transfers')).toBeUndefined()
        expect(optionOf('[]', 'transfers')).toBeUndefined()
    })
})

describe('withOption', () => {
    it('sets an option and keeps the others where they are', () => {
        const text = JSON.stringify({ transfers: 8, checkers: 16 }, null, 2)
        expect(withOption(text, 'transfers', 4)).toBe(
            JSON.stringify({ transfers: 4, checkers: 16 }, null, 2)
        )
        expect(withOption(text, 'fast_list', true)).toBe(
            JSON.stringify({ transfers: 8, checkers: 16, fast_list: true }, null, 2)
        )
    })

    it('takes an option out for undefined', () => {
        expect(withOption('{"checksum": true, "a": 1}', 'checksum', undefined)).toBe(
            JSON.stringify({ a: 1 }, null, 2)
        )
        expect(withOption('{}', 'checksum', undefined)).toBe('{}')
    })

    it('writes nothing over text that does not read', () => {
        expect(withOption('{"a": ', 'checksum', true)).toBeUndefined()
        expect(withOption('null', 'checksum', true)).toBeUndefined()
    })

    it('reads back what it wrote', () => {
        const text = withOption('{}', 'exclude', ['*.tmp', 'cache/**'])!
        expect(optionOf(text, 'exclude')).toEqual(['*.tmp', 'cache/**'])
    })
})

describe('itemsOf', () => {
    it('reads a list, or one text as one item', () => {
        expect(itemsOf(['*.tmp', '', '*.log'])).toEqual(['*.tmp', '*.log'])
        expect(itemsOf('*.tmp')).toEqual(['*.tmp'])
        expect(itemsOf('')).toEqual([])
        expect(itemsOf(undefined)).toEqual([])
        expect(itemsOf(true)).toEqual([])
    })
})
