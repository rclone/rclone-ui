import type { GroupDefaults } from '../../../lib/catalog'
import type { FlagValue } from '../../../types/rclone'

type Options = Record<string, FlagValue>

export type SentOptions = Record<string, FlagValue | null>

export function optionName(key: string): string {
    return key.replace(/^--/, '').replaceAll('-', '_')
}

function namesIn(groups: Iterable<Readonly<Record<string, unknown>> | null | undefined>) {
    const names = new Set<string>()
    for (const options of groups) {
        for (const key of Object.keys(options ?? {})) names.add(optionName(key))
    }
    return names
}

export function seedGroups<K extends string>(
    keys: readonly K[],
    defaults: GroupDefaults | undefined,
    preset: Partial<Record<K, Readonly<Record<string, unknown>> | null>> | undefined
): Record<K, Options> {
    const named = namesIn(keys.map((key) => preset?.[key]))
    const out = {} as Record<K, Options>
    for (const key of keys) {
        const options: Options = {}
        for (const [name, value] of Object.entries(defaults?.[key] ?? {})) {
            if (!named.has(optionName(name))) options[name] = value
        }
        for (const [name, value] of Object.entries(preset?.[key] ?? {})) {
            if (value !== null) options[name] = value as FlagValue
        }
        out[key] = options
    }
    return out
}

export function difference<K extends string>(
    defaults: Partial<Record<K, Readonly<Options>>> | undefined,
    groups: Readonly<Record<K, Readonly<Options>>>
): Record<K, SentOptions> {
    const keys = Object.keys(groups) as K[]
    const named = namesIn(keys.map((key) => groups[key]))
    const out = {} as Record<K, SentOptions>
    for (const key of keys) {
        const own = defaults?.[key] ?? {}
        const sent: SentOptions = {}
        for (const [name, value] of Object.entries(groups[key])) {
            if (!Object.hasOwn(own, name) || JSON.stringify(own[name]) !== JSON.stringify(value)) {
                sent[name] = value
            }
        }
        for (const name of Object.keys(own)) {
            if (!named.has(optionName(name))) sent[name] = null
        }
        out[key] = sent
    }
    return out
}
