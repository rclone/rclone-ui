// The app's default options on the operation pages. The core owns the defaults (Catalog.defaults)
// and applies them under every run, whatever starts it. A page shows them in its option groups,
// so the user sees what will run, and sends only what differs from them. A saved template,
// schedule or automount then holds only the user's own choices, and follows the defaults if they
// change.

import type { GroupDefaults } from '../../../lib/catalog'
import type { FlagValue } from '../../../types/rclone'

type Options = Record<string, FlagValue>

/** A group's options as a page sends them. A null means that rclone's own default applies. */
export type SentOptions = Record<string, FlagValue | null>

/** rclone's name for an option: `--dry-run` and `dry-run` are both `dry_run`. */
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

/**
 * The options that each group starts with: the defaults, with the preset's options over them. A
 * default is left out when the preset names the same option in any group, under any spelling,
 * because the core applies a default only when no group names it. A null in the preset removes
 * the default, and the group's text shows nothing for that option.
 */
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

/**
 * The options that a page sends for its groups, given the defaults that their texts started from.
 * A value that equals its default in the same group is left out, because the core adds it again.
 * A default that no group names any more is sent as null, so the core leaves it out too and
 * rclone's own default applies. Every other option is sent as it is.
 */
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
