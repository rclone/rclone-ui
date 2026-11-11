import { Kind, type Option, type OptionValue } from '../../lib/catalog'
import type { FlagValue } from '../../types/rclone'

// The options editor writes JSON. The core reads each value the way rclone reads the option's
// flag, so a JSON number or boolean is read as its literal text. The editor therefore converts
// rclone's text to a JSON value only when JSON represents it exactly. Everything else stays as
// text, for rclone to parse or to reject with its own error message.

/**
 * Parses a group's JSON text into options. Returns undefined when the text isn't valid JSON, or
 * when it isn't a plain object (`null`, an array, a number), because no page can use that as
 * options.
 */
export function parseOptions(text: string): Record<string, FlagValue> | undefined {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return undefined
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, FlagValue>
}

export type AvailableOption = Pick<
    Option,
    'name' | 'help' | 'defaultText' | 'default' | 'kind' | 'choices'
>

/** A value suggested for an option. `token` is the JSON that the editor writes for it. */
export type SelectorPreset = {
    label: string
    token: string
    isDefault: boolean
}

// An int as rclone formats it (fmt.Sprint). It has no leading zero, which rclone reads as octal.
const INT = /^-?(0|[1-9]\d*)$/
// A float as rclone formats it (fmt.Sprint: 0.5, 1e+06), which is also a valid JSON number.
const FLOAT = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/

/**
 * Converts rclone's text for a value into the JSON value that the editor starts with. A bool or
 * tristate that is exactly `true` or `false` becomes a boolean, an int or float that JSON can
 * hold exactly becomes a number, and a list stays a list. Any other text is kept as it is (a
 * tristate's "unset", a size like "16Mi", or a value that rclone would reject), and the core
 * reads it with the option's own parser.
 */
export function toOptionValue(value: OptionValue, kind: Kind): FlagValue {
    if (Array.isArray(value)) return value
    if (kind === Kind.KindBool || kind === Kind.KindTristate) {
        if (value === 'true') return true
        if (value === 'false') return false
    }
    if (kind === Kind.KindInt && INT.test(value) && Number.isSafeInteger(Number(value))) {
        return Number(value)
    }
    if (kind === Kind.KindFloat && FLOAT.test(value) && Number.isFinite(Number(value))) {
        return Number(value)
    }
    return value
}

/**
 * Returns an option's default value. For a list with elements, the default is the list itself,
 * as rclone's rc JSON writes it (a serve's addr is ["127.0.0.1:8080"]).
 */
export function defaultValue(option: AvailableOption): OptionValue {
    const list: unknown = option.default
    if (option.kind === Kind.KindList && Array.isArray(list) && list.length > 0) {
        return list.map(String)
    }
    return option.defaultText
}

/**
 * Returns the values suggested for an option: its default, then the catalog's choices (a fixed
 * set, or rclone's examples and common values), without duplicates.
 */
export function buildSelectorPresets(option: AvailableOption): SelectorPreset[] {
    const values = option.choices.map((c) => c.value)
    if (option.kind === Kind.KindBool) {
        values.push('true', 'false')
    }
    if (values.length === 0) {
        return []
    }

    const presets: SelectorPreset[] = []
    const seenTokens = new Set<string>()
    const pushPreset = (label: string, value: OptionValue, isDefault: boolean) => {
        const token = JSON.stringify(toOptionValue(value, option.kind))
        if (seenTokens.has(token)) {
            return
        }
        seenTokens.add(token)
        presets.push({ label: label || '""', token, isDefault })
    }

    pushPreset(option.defaultText, defaultValue(option), true)
    for (const value of values) {
        pushPreset(value, value, false)
    }
    return presets
}
