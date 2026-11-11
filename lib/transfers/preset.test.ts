import { expect, test } from 'vitest'
import { formOf } from '../operations'
import { decodePreset, encodePreset, presetRoute } from './preset'

test('a preset goes through the URL and back as it was', () => {
    const preset = formOf('sync', {
        source: 'drive:Fotos/été',
        destination: '/backup',
        options: { filter: { exclude: ['*.tmp'] } },
    })
    const encoded = encodePreset(preset)
    expect(encoded).not.toMatch(/[+/=]/)
    expect(decodePreset(encoded)).toEqual(preset)
    expect(presetRoute(preset)).toBe(`/sync?preset=${encoded}`)
})

test('a preset that does not read is none', () => {
    expect(decodePreset(null)).toBeUndefined()
    expect(decodePreset('%%%')).toBeUndefined()
    expect(decodePreset(encodePreset({ copy: {} } as never))).toBeUndefined()
})
