import type { FlagValue } from '@/lib/rclone/types'

/**
 * What an rclone option `Type` means for the UI. Backend options (`config/providers`) and global
 * flags (`options/info`) share the same type names, so the remote form, the options editor's
 * presets and the template importer all read them from here. Anything not classified renders as
 * plain text: rclone parses every config value from a string, exactly like its CLI wizard.
 */
export type OptionLike = {
    Name: string
    Type: string
    DefaultStr?: string
    Default?: unknown
    Examples?: Array<{ Value: string; Help: string }>
    Exclusive?: boolean
}

export type OptionChoice = { Value: string; Help: string }

export type OptionKind = 'bool' | 'number' | 'text'

const NUMBER_TYPES = /^(u?int|float)/i
const WHITESPACE = /\s+/

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on'])
const FALSE_VALUES = new Set(['false', '0', 'no', 'off'])
const NULL_VALUES = new Set(['', 'null', 'none', 'unset', 'default', 'auto'])

export const TYPE_PRESET_VALUES: Record<string, string[]> = {
    SizeSuffix: ['0', '8M', '16M', '32M', '64M', '128M', '256M', '512M', '1G'],
    Duration: ['0s', '5s', '30s', '1m', '5m', '30m', '1h', '6h', '24h'],
}

export const FIELD_PRESET_VALUES: Record<string, string[]> = {
    order_by: [
        'name,ascending',
        'name,descending',
        'size,ascending',
        'size,descending',
        'modtime,ascending',
        'modtime,descending',
    ],
}

const TRISTATE_VALUES = ['unset', 'true', 'false']

export function optionKind(option: Pick<OptionLike, 'Type'>): OptionKind {
    if (option.Type === 'bool') return 'bool'
    if (NUMBER_TYPES.test(option.Type)) return 'number'
    return 'text'
}

/**
 * The values a field can offer: rclone's own `Examples` (with their help) first, then the presets
 * shared with the options editor. `exclusive` means the list is closed (a Tristate, an enum type
 * written as `a|b|c`, or an option rclone marks `Exclusive`).
 */
export function optionChoices(
    option: OptionLike
): { values: OptionChoice[]; exclusive: boolean } | null {
    if (option.Type === 'Tristate') {
        return { values: TRISTATE_VALUES.map((Value) => ({ Value, Help: '' })), exclusive: true }
    }
    if (option.Type.includes('|')) {
        return {
            values: option.Type.split('|').map((Value) => ({ Value, Help: '' })),
            exclusive: true,
        }
    }

    const values: OptionChoice[] = []
    const seen = new Set<string>()
    const push = (choice: OptionChoice) => {
        if (seen.has(choice.Value)) return
        seen.add(choice.Value)
        values.push(choice)
    }
    for (const example of option.Examples ?? []) push(example)
    for (const value of FIELD_PRESET_VALUES[option.Name] ?? []) push({ Value: value, Help: '' })
    for (const value of TYPE_PRESET_VALUES[option.Type] ?? []) push({ Value: value, Help: '' })

    return values.length > 0 ? { values, exclusive: !!option.Exclusive } : null
}

/** The default as text for a form field. Go prints slices as `[a b]`; rclone reads `a,b`. */
export function optionDefaultText(option: OptionLike): string {
    if (option.Type === 'stringArray' && Array.isArray(option.Default)) {
        return option.Default.map(String).join(',')
    }
    return option.DefaultStr ?? ''
}

export function parseBooleanString(value: string): boolean | null {
    const normalized = value.trim().toLowerCase()
    if (TRUE_VALUES.has(normalized)) return true
    if (FALSE_VALUES.has(normalized)) return false
    return null
}

/** `undefined` means the text is not a Tristate at all; `null` is rclone's "unset". */
export function parseTristateString(value: string): boolean | null | undefined {
    const booleanValue = parseBooleanString(value)
    if (booleanValue !== null) return booleanValue
    if (NULL_VALUES.has(value.trim().toLowerCase())) return null
    return undefined
}

/** Coerces a global value or `DefaultStr` into the JSON value the options editor writes. */
export function toOptionValue(value: unknown, optionType: string): unknown {
    const normalizedType = optionType.toLowerCase()

    if (normalizedType === 'bool') {
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
            const parsed = parseBooleanString(value)
            if (parsed !== null) return parsed
        }
        return Boolean(value || false)
    }

    if (normalizedType === 'tristate') {
        if (value === null) return null
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
            const parsed = parseTristateString(value)
            if (parsed !== undefined) return parsed
        }
        return null
    }

    if (normalizedType.includes('int') || normalizedType.includes('float')) {
        const parsedNumber = Number(value)
        return Number.isFinite(parsedNumber) ? parsedNumber : 0
    }

    if (value === null || value === undefined) return ''

    return value
}

/**
 * The value of one `--flag[ value]` from a pasted command line, typed by the flag's `Type`. A
 * flag without a value is a switch (`true`); text that does not fit its type stays text.
 */
export function parseFlagText(text: string | undefined, type: string | undefined): FlagValue {
    if (type === 'bool') return text !== 'false'
    if (type === 'Tristate') return text === 'null' ? null : text !== 'false'
    if (type === 'stringArray') return text === undefined ? [] : [text]
    if (type === 'SpaceSepList') return text?.split(WHITESPACE).filter(Boolean) ?? []
    if (type && NUMBER_TYPES.test(type) && text) {
        const numberValue = Number(text)
        return Number.isNaN(numberValue) ? text : numberValue
    }
    return text ?? true
}
