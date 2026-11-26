import {
    type Dispatch,
    type SetStateAction,
    startTransition,
    useCallback,
    useMemo,
    useRef,
    useState,
} from 'react'
import { type GroupDefaults, useOperationDefaults } from '../../../lib/catalog'
import type { Operations } from '../../../lib/core/types'
import { getRemoteName } from '../../../lib/format'
import type { OperationName } from '../../../lib/operations'
import { pathProblem } from '../../../lib/paths'
import type { FlagValue } from '../../../types/rclone'
import { parseOptions } from '../optionValues'
import { difference, type SentOptions, seedGroups } from './defaults'
import type { GroupKey } from './optionGroups'

export interface OptionGroupState {
    options: Record<string, FlagValue>
    valid: boolean
    sent: SentOptions
    jsonString: string
    setJsonString: (value: string) => void
}

export interface RemoteOptionsGroupState {
    options: Record<string, Record<string, FlagValue>>
    json: Record<string, string>
    setJson: Dispatch<SetStateAction<Record<string, string>>>
}

type Options = Record<string, FlagValue>

export type ParsedTexts<K extends string> =
    | { options: Record<K, Options>; invalid?: undefined }
    | { options?: undefined; invalid: K }

export function parseGroups<K extends string>(
    keys: readonly K[],
    json: Record<K, string>
): { options: Partial<Record<K, Options>>; invalid: K[] } {
    const options: Partial<Record<K, Options>> = {}
    const invalid: K[] = []
    for (const key of keys) {
        const parsed = parseOptions(json[key])
        if (parsed) options[key] = parsed
        else invalid.push(key)
    }
    return { options, invalid }
}

export function parseRemotes(
    remoteNames: readonly string[],
    remoteJson: Record<string, string>
): ParsedTexts<string> {
    const options: Record<string, Options> = {}
    for (const name of remoteNames) {
        const parsed = parseOptions(remoteJson[name] ?? '{}')
        if (!parsed) return { invalid: name }
        options[name] = parsed
    }
    return { options }
}

export function remoteNamesOf(paths: readonly (string | undefined)[]): string[] {
    const names = new Set<string>()
    for (const path of paths) {
        if (!path || pathProblem(path)) continue
        const name = getRemoteName(path)
        if (name && name !== ':local') names.add(name)
    }
    return [...names]
}

export function textsEdited(
    initial: Readonly<Record<string, string>>,
    current: Readonly<Record<string, string>>
): boolean {
    const isEmpty = (text: string | undefined) =>
        text === undefined || text.replace(/\s/g, '') === '{}'
    for (const key of new Set([...Object.keys(initial), ...Object.keys(current)])) {
        const before = initial[key]
        const now = current[key]
        if (before === now || (isEmpty(before) && isEmpty(now))) continue
        return true
    }
    return false
}

const NO_REMOTES: readonly string[] = []

function basesOf<K extends string>(
    keys: readonly K[],
    defaults: GroupDefaults | undefined
): Record<K, Options> {
    return Object.fromEntries(keys.map((key) => [key, defaults?.[key] ?? {}])) as Record<K, Options>
}

function textsOf<K extends string>(
    keys: readonly K[],
    groups: Record<K, Options>
): Record<K, string> {
    return Object.fromEntries(
        keys.map((key) => [key, JSON.stringify(groups[key], null, 2)])
    ) as Record<K, string>
}

type Incoming = Readonly<Record<string, unknown>> | null | undefined

export function mergeTemplate<K extends string>(
    keys: readonly K[],
    current: Readonly<Record<K, Options>>,
    incoming: Partial<Record<K, Incoming>>
): Partial<Record<K, Options>> {
    const out: Partial<Record<K, Options>> = {}
    for (const key of keys) {
        const options = incoming[key]
        if (!options) continue
        const merged: Options = { ...current[key] }
        for (const [name, value] of Object.entries(options)) {
            if (value === null) delete merged[name]
            else merged[name] = value as FlagValue
        }
        out[key] = merged
    }
    return out
}

export function useOptionGroups<K extends GroupKey>({
    operation,
    groups,
    remoteNames,
    initial,
    initialRemotes,
}: {
    operation?: OperationName
    groups: readonly K[]
    remoteNames?: readonly string[]
    initial?: Operations.Groups
    initialRemotes?: Operations.Groups['remotes']
}) {
    const [keys] = useState(groups)
    const names = remoteNames ?? NO_REMOTES
    const defaults = useOperationDefaults(operation)

    const seedsOf = (defaults: GroupDefaults | undefined) => ({
        groups: textsOf(
            keys,
            seedGroups(keys, defaults, initial as Partial<Record<K, Incoming>> | undefined)
        ),
        remotes: Object.fromEntries(
            Object.entries(initialRemotes ?? {}).map(([name, options]) => [
                name,
                JSON.stringify(options, null, 2),
            ])
        ) as Record<string, string>,
        complete: defaults !== undefined,
    })
    const [seeds, setSeeds] = useState(() => seedsOf(defaults))
    const [jsonStrings, setJsonStrings] = useState<Record<K, string>>(seeds.groups)
    const [remoteJson, setRemoteJson] = useState<Record<string, string>>(seeds.remotes)
    const [bases, setBases] = useState(() => basesOf(keys, defaults))

    if (defaults && !seeds.complete) {
        if (textsEdited(seeds.groups, jsonStrings)) {
            setSeeds({ ...seeds, complete: true })
        } else {
            const next = seedsOf(defaults)
            setSeeds(next)
            setJsonStrings(next.groups)
            setBases(basesOf(keys, defaults))
        }
    }
    const edited = useMemo(
        () => textsEdited(seeds.groups, jsonStrings) || textsEdited(seeds.remotes, remoteJson),
        [seeds, jsonStrings, remoteJson]
    )

    const lastGood = useRef<{
        groups: Partial<Record<K, Options>>
        remotes: Record<string, Options>
    }>({ groups: {}, remotes: {} })
    const { parsed, invalid, remoteParsed, jsonError } = useMemo(() => {
        const groupsRead = parseGroups(keys, jsonStrings)
        const remotesRead = parseRemotes(names, remoteJson)
        const groups = {} as Record<K, Options>
        for (const key of keys) {
            groups[key] = groupsRead.options[key] ?? lastGood.current.groups[key] ?? {}
        }
        lastGood.current = {
            groups,
            remotes: remotesRead.options ?? lastGood.current.remotes,
        }
        return {
            parsed: groups,
            invalid: new Set(groupsRead.invalid),
            remoteParsed: lastGood.current.remotes,
            jsonError: groupsRead.invalid[0] ?? remotesRead.invalid ?? null,
        }
    }, [keys, jsonStrings, names, remoteJson])

    const setters = useMemo(() => {
        const map = {} as Record<K, (value: string) => void>
        for (const key of keys) {
            map[key] = (value: string) =>
                setJsonStrings((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }))
        }
        return map
    }, [keys])

    const sent = useMemo(() => difference(bases, parsed), [bases, parsed])

    const groupStates = useMemo(() => {
        const map = {} as Record<K, OptionGroupState>
        for (const key of keys) {
            map[key] = {
                options: parsed[key],
                valid: !invalid.has(key),
                sent: sent[key],
                jsonString: jsonStrings[key],
                setJsonString: setters[key],
            }
        }
        return map
    }, [keys, parsed, invalid, sent, jsonStrings, setters])

    const remotes: RemoteOptionsGroupState = useMemo(
        () => ({ options: remoteParsed, json: remoteJson, setJson: setRemoteJson }),
        [remoteParsed, remoteJson]
    )

    const write = useCallback(
        (texts: Partial<Record<K, string>>, fresh: readonly K[]) => {
            startTransition(() => {
                setJsonStrings((prev) => {
                    let changed = false
                    const next = { ...prev }
                    for (const key of Object.keys(texts) as K[]) {
                        const text = texts[key]
                        if (text !== undefined && next[key] !== text) {
                            next[key] = text
                            changed = true
                        }
                    }
                    return changed ? next : prev
                })
                if (fresh.length > 0) {
                    const reset = basesOf(fresh, defaults)
                    setBases((prev) => ({ ...prev, ...reset }))
                }
            })
        },
        [defaults]
    )

    const replace = useCallback(
        (grouped: Partial<Record<K, Incoming>>) => {
            write(textsOf(keys, seedGroups(keys, defaults, grouped)), keys)
        },
        [keys, defaults, write]
    )

    const applyTemplate = useCallback(
        (groups: Operations.Groups, shouldMerge: boolean) => {
            const incoming = groups as Partial<Record<K, Incoming>>
            if (!shouldMerge) {
                replace(incoming)
                return
            }
            const merged = mergeTemplate(keys, parsed, incoming)
            const texts: Partial<Record<K, string>> = {}
            for (const key of Object.keys(merged) as K[]) {
                texts[key] = JSON.stringify(merged[key], null, 2)
            }
            write(texts, [])
        },
        [keys, parsed, replace, write]
    )

    const getMergedOptions = useCallback((): Record<string, FlagValue> => {
        const merged: Record<string, FlagValue> = {}
        for (const key of keys) {
            Object.assign(merged, sent[key])
        }
        return merged
    }, [keys, sent])

    const resetJson = useCallback(() => {
        const texts = textsOf(keys, seedGroups(keys, defaults, undefined))
        setJsonStrings((prev) => {
            let changed = false
            const next = { ...prev }
            for (const key of keys) {
                if (next[key] !== texts[key]) {
                    next[key] = texts[key]
                    changed = true
                }
            }
            return changed ? next : prev
        })
        setBases(basesOf(keys, defaults))
        setRemoteJson((prev) => (Object.keys(prev).length === 0 ? prev : {}))
    }, [keys, defaults])

    return {
        jsonError,
        edited,
        keys,
        groups: groupStates,
        remoteNames,
        remotes,
        applyTemplate,
        replace,
        getMergedOptions,
        resetJson,
    }
}

export type OptionGroups<K extends GroupKey> = ReturnType<typeof useOptionGroups<K>>
