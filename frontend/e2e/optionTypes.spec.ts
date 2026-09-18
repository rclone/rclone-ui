import { expect, test } from '@playwright/test'
import {
    optionChoices,
    optionDefaultText,
    optionKind,
    parseFlagText,
} from '../lib/rclone/optionTypes'

// lib/rclone/optionTypes.ts is pure, so it runs in the test process itself. It is the one place
// that decides what an rclone option `Type` means for the remote form, the options editor's
// presets and the template importer; a type it does not classify used to vanish from the form.

const option = (
    Type: string,
    extra: Partial<{
        Name: string
        DefaultStr: string
        Default: unknown
        Examples: Array<{ Value: string; Help: string }>
        Exclusive: boolean
    }> = {}
) => ({ Name: 'opt', Type, DefaultStr: '', ...extra })

test('every rclone option type renders as something', () => {
    // The types rclone 1.75 uses for backend options that the form used to drop.
    for (const type of ['SpaceSepList', 'CommaSepList', 'SizeSuffix', 'Encoding', 'Time']) {
        expect(optionKind(option(type)), type).toBe('text')
    }
    for (const type of ['int', 'int64', 'uint32', 'float64']) {
        expect(optionKind(option(type)), type).toBe('number')
    }
    expect(optionKind(option('bool'))).toBe('bool')

    expect(optionChoices(option('Tristate'))).toEqual({
        values: [
            { Value: 'unset', Help: '' },
            { Value: 'true', Help: '' },
            { Value: 'false', Help: '' },
        ],
        exclusive: true,
    })
    expect(optionChoices(option('mtime|atime|btime|ctime'))).toEqual({
        values: ['mtime', 'atime', 'btime', 'ctime'].map((Value) => ({ Value, Help: '' })),
        exclusive: true,
    })

    // Backend examples come first and keep their help; the shared size presets follow without
    // repeating a value the examples already offer.
    const sizes = optionChoices(
        option('SizeSuffix', {
            Examples: [
                { Value: '1M', Help: 'small' },
                { Value: '8M', Help: 'medium' },
            ],
        })
    )
    expect(sizes?.exclusive).toBe(false)
    expect(sizes?.values.slice(0, 2)).toEqual([
        { Value: '1M', Help: 'small' },
        { Value: '8M', Help: 'medium' },
    ])
    const sizeValues = sizes?.values.map((v) => v.Value) ?? []
    expect(sizeValues).toContain('64M')
    expect(sizeValues).toContain('1G')
    expect(new Set(sizeValues).size).toBe(sizeValues.length)

    expect(optionChoices(option('string'))).toBeNull()
    expect(optionChoices(option('int'))).toBeNull()

    // Go prints slice defaults as `[a b]`; rclone stores and reads the comma form.
    expect(
        optionDefaultText(option('stringArray', { Default: ['a', 'b'], DefaultStr: '[a b]' }))
    ).toBe('a,b')
    expect(optionDefaultText(option('SizeSuffix', { DefaultStr: '500Mi' }))).toBe('500Mi')
})

test('a --flag import keeps the template importer typing', () => {
    expect(parseFlagText(undefined, 'bool')).toBe(true)
    expect(parseFlagText('false', 'bool')).toBe(false)
    expect(parseFlagText('null', 'Tristate')).toBeNull()
    expect(parseFlagText('true', 'Tristate')).toBe(true)
    expect(parseFlagText('a b', 'SpaceSepList')).toEqual(['a', 'b'])
    expect(parseFlagText(undefined, 'stringArray')).toEqual([])
    expect(parseFlagText('x', 'stringArray')).toEqual(['x'])
    expect(parseFlagText('5', 'int')).toBe(5)
    expect(parseFlagText('abc', 'int')).toBe('abc')
    expect(parseFlagText('64M', 'SizeSuffix')).toBe('64M')
    expect(parseFlagText(undefined, undefined)).toBe(true)
    expect(parseFlagText('plain', undefined)).toBe('plain')
})
