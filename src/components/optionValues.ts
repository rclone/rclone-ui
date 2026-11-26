import { Kind, type Option, type OptionValue } from '../../lib/catalog'
import type { FlagValue } from '../../types/rclone'

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

export type SelectorPreset = {
    label: string
    token: string
    isDefault: boolean
}

const INT = /^-?(0|[1-9]\d*)$/
const FLOAT = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/

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

export function defaultValue(option: AvailableOption): OptionValue {
    const list: unknown = option.default
    if (option.kind === Kind.KindList && Array.isArray(list) && list.length > 0) {
        return list.map(String)
    }
    return option.defaultText
}

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
