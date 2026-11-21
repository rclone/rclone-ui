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
    // The group's options from the last successful parse of its text.
    options: Record<string, FlagValue>
    /** Whether the group's text is a valid JSON object now. */
    valid: boolean
    // The options that the page sends for the group: only what differs from the app's defaults
    // (see defaults.ts), which the core adds again.
    sent: SentOptions
    jsonString: string
    setJsonString: (value: string) => void
}

export interface RemoteOptionsGroupState {
    // The options of the selected remotes from the last successful parse, by remote name. They
    // are sent as the arguments' `remotes`.
    options: Record<string, Record<string, FlagValue>>
    // Each remote's JSON text, by remote name. A remote with no text has no options ('{}').
    json: Record<string, string>
    setJson: Dispatch<SetStateAction<Record<string, string>>>
}

type Options = Record<string, FlagValue>

/** The result of parsing several texts: the options of each, or the first key that failed. */
export type ParsedTexts<K extends string> =
    | { options: Record<K, Options>; invalid?: undefined }
    | { options?: undefined; invalid: K }

/**
 * Parses each option group's text. Returns the options of the texts that parse, and the keys of
 * those that don't, in `keys` order.
 */
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

/**
 * Parses the remote tabs' texts, but only for `remoteNames`. A remote with no text sets nothing.
 * A tab left over from a remote that no path uses any more is neither sent nor saved in the
 * preset.
 */
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

/**
 * Returns the remotes named by the paths, in order and without duplicates. Local paths (and
 * `:local:`) name no remote with options to set, and a path with a problem (see pathProblem) is
 * left out until it is fixed.
 */
export function remoteNamesOf(paths: readonly (string | undefined)[]): string[] {
    const names = new Set<string>()
    for (const path of paths) {
        if (!path || pathProblem(path)) continue
        const name = getRemoteName(path)
        if (name && name !== ':local') names.add(name)
    }
    return [...names]
}

/**
 * Reports whether any text differs from its `initial` value, compared by key. A key that is
 * missing on one side and '{}' (no options) on the other isn't a change, because that is a
 * remote's tab with nothing typed in it.
 */
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

/** A group's options as a template or a preset gives them. A null removes an option. */
type Incoming = Readonly<Record<string, unknown>> | null | undefined

/**
 * The options of each group that a template sets, merged over the group's `current` options. The
 * template's values win, and its nulls remove options. Groups that the template leaves out are
 * left out of the result, so their texts stay as they are.
 */
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

/**
 * Owns the option-group state of an operation page or a drawer: each group's JSON text, the
 * remotes' texts, template loading and resets. The texts are the only state, apart from the
 * defaults that they started from. The options and `jsonError` are parsed from them in the same
 * render that changes them, so what a page sends or blocks on is never a render behind.
 * `jsonError` names the first group (in `groups` order) whose text is invalid, and then the first
 * selected remote whose text is invalid. Meanwhile each group's options keep the last values that
 * parsed.
 *
 * Each group's text starts with the app's defaults for `operation` (from the core's catalog),
 * with `initial` (a preset's option groups) over them, so the page shows what will run. A group's
 * `sent` options leave out what equals those defaults (see difference in defaults.ts). Without an
 * operation, as in the template drawer, there are no defaults, and `sent` is what the texts hold.
 * `initialRemotes` sets the starting texts for the remotes. Resets go back to the defaults.
 *
 * `remoteNames` (from remoteNamesOf on the page's paths) lists the remotes whose tabs are read.
 * Pages without a Remotes section leave it out.
 *
 * The groups must be static, because they are captured on the first render.
 */
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
    // The groups are static per page. Keep the first render's value, so the memos don't depend on
    // the identity of an inline array.
    const [keys] = useState(groups)
    const names = remoteNames ?? NO_REMOTES
    const defaults = useOperationDefaults(operation)

    // The starting texts, set in the first render: the defaults with the preset's options over
    // them. They must be in place before any effect runs, because START can be pressed that early.
    // Otherwise a Sync from a preset could start without the preset's exclude filter, and delete
    // what the filter protects. They are also kept to tell whether the texts were edited.
    // `complete` says whether the defaults were there, because they arrive with the catalog.
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
    // The defaults under each group's text. What the page sends is the difference from them. They
    // change only when a text is written again from the defaults: by a reset or a replace.
    const [bases, setBases] = useState(() => basesOf(keys, defaults))

    // When the catalog arrives after the first render, the texts start again from its defaults,
    // unless the user has already edited them. Edited texts are kept, and their bases stay empty,
    // so nothing they lack is sent as removed. The core adds the defaults that they don't name.
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
    // Whether any text differs from what the page opened with. FollowsQuery uses this to ask
    // before a new route replaces the page.
    const edited = useMemo(
        () => textsEdited(seeds.groups, jsonStrings) || textsEdited(seeds.remotes, remoteJson),
        [seeds, jsonStrings, remoteJson]
    )

    // The last successful parse of each group, and of the remotes. The subtitles, the metadata
    // mapper and the arguments use it while a text is being edited and is invalid. START is
    // blocked in the meantime.
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

    // Stable setters for each group (the groups are static). Returning `prev` unchanged when the
    // value is the same lets React's Object.is check skip the re-render.
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

    // Writes the texts that changed. The groups in `fresh` start again from the defaults, so their
    // bases become the defaults again.
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

    // Every group starts again from its defaults, with `grouped` over them, as a preset's options
    // do. The template drawer fills its groups this way from a pasted command or a saved template.
    // It depends only on the defaults, so an effect can call it without running again on each edit.
    const replace = useCallback(
        (grouped: Partial<Record<K, Incoming>>) => {
            write(textsOf(keys, seedGroups(keys, defaults, grouped)), keys)
        },
        [keys, defaults, write]
    )

    // Loading a template writes the JSON texts, and the options are parsed from them. The core
    // sorts the template's options into the groups of the page's form (templates.Groups). In
    // merge mode, each group that the template sets is spread over the current options, and its
    // nulls remove options. In replace mode, every group goes back to its defaults, with the
    // template's options over them (replace).
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

    // The options that the page sends, from all groups merged in `groups` order, without the
    // remotes. TemplatesDropdown saves them as a template's options through getOptions, so a
    // template holds only what differs from the defaults.
    const getMergedOptions = useCallback((): Record<string, FlagValue> => {
        const merged: Record<string, FlagValue> = {}
        for (const key of keys) {
            Object.assign(merged, sent[key])
        }
        return merged
    }, [keys, sent])

    // Resets every group's JSON text to its defaults and clears the remote options.
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
        // Undefined when the page has no Remotes section.
        remoteNames,
        remotes,
        applyTemplate,
        replace,
        getMergedOptions,
        resetJson,
    }
}

export type OptionGroups<K extends GroupKey> = ReturnType<typeof useOptionGroups<K>>
