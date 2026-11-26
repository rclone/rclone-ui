import { useCallback, useMemo } from 'react'
import type { FlagValue } from '../../../types/rclone'
import { parseOptions } from '../optionValues'

export function optionOf(json: string, key: string): FlagValue | undefined {
    return parseOptions(json)?.[key] ?? undefined
}

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

export function itemsOf(value: FlagValue | undefined): string[] {
    if (Array.isArray(value)) return value.filter((item) => item !== '')
    if (typeof value === 'string' && value !== '') return [value]
    return []
}

export interface BoundGroup {
    jsonString: string
    setJsonString: (value: string) => void
}

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
