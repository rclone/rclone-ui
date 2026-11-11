import { describe, expect, it } from 'vitest'
import { Kind } from '../../lib/catalog'
import { Option } from '../../lib/shell/bindings/github.com/rclone/rclone-ui/core/catalog/models'
import { buildSelectorPresets, defaultValue, parseOptions, toOptionValue } from './optionValues'

describe('parseOptions', () => {
    it('reads a plain object, and nothing else', () => {
        expect(parseOptions('{"transfers": 4, "exclude": ["*.tmp"]}')).toEqual({
            transfers: 4,
            exclude: ['*.tmp'],
        })
        expect(parseOptions('{}')).toEqual({})
        // A typed `null`, a list or a number isn't a set of options, just like invalid JSON.
        for (const text of ['null', '[]', '[1]', '5', '"x"', 'true', '', '{"a":']) {
            expect(parseOptions(text)).toBeUndefined()
        }
    })
})

describe('toOptionValue', () => {
    it('writes only what JSON says exactly as JSON', () => {
        expect(toOptionValue('true', Kind.KindBool)).toBe(true)
        expect(toOptionValue('false', Kind.KindTristate)).toBe(false)
        expect(toOptionValue('8', Kind.KindInt)).toBe(8)
        expect(toOptionValue('-1', Kind.KindInt)).toBe(-1)
        expect(toOptionValue('0.5', Kind.KindFloat)).toBe(0.5)
        expect(toOptionValue('1e+06', Kind.KindFloat)).toBe(1e6)
        expect(toOptionValue(['a,b', 'c'], Kind.KindList)).toEqual(['a,b', 'c'])
    })

    it('leaves any other text for rclone to read', () => {
        expect(toOptionValue('unset', Kind.KindTristate)).toBe('unset')
        expect(toOptionValue('yes', Kind.KindBool)).toBe('yes')
        expect(toOptionValue('', Kind.KindBool)).toBe('')
        expect(toOptionValue('', Kind.KindInt)).toBe('')
        expect(toOptionValue('0x10', Kind.KindInt)).toBe('0x10')
        expect(toOptionValue('010', Kind.KindInt)).toBe('010')
        expect(toOptionValue('9007199254740993', Kind.KindInt)).toBe('9007199254740993')
        expect(toOptionValue('1.5', Kind.KindInt)).toBe('1.5')
        expect(toOptionValue('+Inf', Kind.KindFloat)).toBe('+Inf')
        expect(toOptionValue('16Mi', Kind.KindSize)).toBe('16Mi')
        expect(toOptionValue('100', Kind.KindSize)).toBe('100')
        expect(toOptionValue('5m0s', Kind.KindDuration)).toBe('5m0s')
        expect(toOptionValue('*.tmp,*.bak', Kind.KindList)).toBe('*.tmp,*.bak')
    })
})

describe('defaultValue', () => {
    it("takes a list's elements from rclone's value, never from its text", () => {
        const addr = Option.createFrom({
            kind: Kind.KindList,
            defaultText: '127.0.0.1:8080',
            default: ['127.0.0.1:8080'],
        })
        expect(defaultValue(addr)).toEqual(['127.0.0.1:8080'])
        const exclude = Option.createFrom({ kind: Kind.KindList, default: null })
        expect(defaultValue(exclude)).toBe('')
        const size = Option.createFrom({ kind: Kind.KindSize, defaultText: '16Mi' })
        expect(defaultValue(size)).toBe('16Mi')
    })
})

describe('buildSelectorPresets', () => {
    // Builds an option as the core sends it. Fields that aren't given get their zero value.
    const tokens = (o: Record<string, unknown>) =>
        buildSelectorPresets(Option.createFrom(o)).map((p) => [p.label, p.token, p.isDefault])

    it("offers the default, then the choices, as the JSON they're written as", () => {
        expect(tokens({ kind: Kind.KindBool, defaultText: 'false' })).toEqual([
            ['false', 'false', true],
            ['true', 'true', false],
        ])
        expect(
            tokens({
                kind: Kind.KindTristate,
                defaultText: 'unset',
                choices: [{ value: 'unset' }, { value: 'true' }, { value: 'false' }],
            })
        ).toEqual([
            ['unset', '"unset"', true],
            ['true', 'true', false],
            ['false', 'false', false],
        ])
        expect(
            tokens({
                kind: Kind.KindSize,
                defaultText: '0',
                choices: [{ value: '0' }, { value: '8M' }],
            })
        ).toEqual([
            ['0', '"0"', true],
            ['8M', '"8M"', false],
        ])
        expect(
            tokens({
                kind: Kind.KindInt,
                defaultText: '4',
                choices: [{ value: '8' }, { value: '' }],
            })
        ).toEqual([
            ['4', '4', true],
            ['8', '8', false],
            ['""', '""', false],
        ])
        expect(tokens({ kind: Kind.KindText, defaultText: 'x' })).toEqual([])
    })
})
