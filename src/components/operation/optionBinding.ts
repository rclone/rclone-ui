import { useCallback, useMemo } from 'react'
import type { FlagValue } from '../../../types/rclone'
import { parseOptions } from '../optionValues'

// The simple controls above the option sections (Mount's Cache, Serve's fields) don't keep a
// value of their own. Each one reads its option from the group's JSON text and writes it back
// there, the same way a chip does, so the controls and the JSON always agree.

/** Returns undefined when `key` isn't set, or when the group's text is invalid. */
export function optionOf(json: string, key: string): FlagValue | undefined {
    return parseOptions(json)?.[key] ?? undefined
}

/**
 * Returns the group's text with `key` set to `value`, or removed when `value` is undefined. It is
 * formatted the same way a chip writes it. Returns undefined while the text is invalid JSON,
 * because writing then would lose what is being typed.
 */
export function withOption(
    json: string,
    key: string,
    value: FlagValue | undefined
): string | undefined {
    const options = parseOptions(json)
    if (!options) return undefined
    const next = { ...options }
    if (value === undefined) delete next[key]
    else next[key] = value
    return JSON.stringify(next, null, 2)
}

/** The items of a list option. A single string is read as one item, as rclone reads it. */
export function itemsOf(value: FlagValue | undefined): string[] {
    if (Array.isArray(value)) return value.filter((item) => item !== '')
    if (typeof value === 'string' && value !== '') return [value]
    return []
}

/** A group's text and its setter, as returned by useOptionGroups. */
export interface BoundGroup {
    jsonString: string
    setJsonString: (value: string) => void
}

/**
 * Binds a control to one option of a group. Returns the value, a setter (undefined removes the
 * option), and whether the control is disabled because the group's text is invalid JSON.
 */
export function useBoundOption(group: BoundGroup, key: string) {
    const { jsonString, setJsonString } = group
    const value = useMemo(() => optionOf(jsonString, key), [jsonString, key])
    const disabled = useMemo(() => parseOptions(jsonString) === undefined, [jsonString])
    const set = useCallback(
        (next: FlagValue | undefined) => {
            const text = withOption(jsonString, key, next)
            if (text !== undefined && text !== jsonString) setJsonString(text)
        },
        [jsonString, key, setJsonString]
    )
    return { value, set, disabled }
}
