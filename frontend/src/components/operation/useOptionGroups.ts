import {
    type Dispatch,
    type SetStateAction,
    startTransition,
    useCallback,
    useEffect,
    useMemo,
    useState,
} from 'react'
import type { FlagValue } from '@/lib/rclone/types'

export interface OptionGroupDef<K extends string = string> {
    // Group identity: the jsonError step name and the state key. Parse order = defs order.
    key: K
    // Key looked up in a template's grouped options, when different from `key` (Move and Bisync
    // load the template's `copy` group into their own group). Defaults to `key`.
    templateKey?: string
    // Seeded into the JSON string on mount and restored by resetJson. Omit for '{}'.
    defaults?: Record<string, FlagValue>
}

export interface OptionGroupState {
    options: Record<string, FlagValue>
    jsonString: string
    setJsonString: (value: string) => void
    locked: boolean
    setLocked: (value: boolean) => void
}

export interface RemoteOptionsGroupState {
    // Last-valid parsed snapshot (the args source). Frozen whole while ANY tab is invalid.
    options: Record<string, Record<string, FlagValue>>
    // Raw per-remote JSON documents (remote name -> options JSON doc), possibly invalid mid-edit.
    json: Record<string, string>
    setJson: Dispatch<SetStateAction<Record<string, string>>>
    // Called by RemoteOptionsSection with the current unique remote names; rebuilds the tab
    // strings from the last-valid parsed doc when the remote COUNT changes (either direction),
    // or unconditionally on `force` (the view's first call after mounting).
    reconcile: (remoteNames: string[], force?: boolean) => void
    locked: boolean
    setLocked: (value: boolean) => void
}

/**
 * Owns the option-group state of an operation page: per-group locked/JSON-string/parsed values,
 * defaults seeding, template load and resets. The JSON string is the single source of truth —
 * parsed values are derived by the parse effect, and invalid JSON retains the last-good parsed
 * values PAGE-WIDE (one try/catch: any invalid group freezes every group's parsed state) with
 * jsonError reporting the first failing group in defs order — exactly the semantics the pages
 * hand-rolled.
 *
 * `withRemotes` adds the remotes group: raw per-remote JSON documents owned here and edited by
 * RemoteOptionsSection tabs. Its parsing is SEPARATE from the groups' try/catch — an invalid
 * remote tab must never set jsonError or disable start; instead retention is ALL-OR-NOTHING
 * across remotes (one invalid tab freezes the parsed snapshot for every remote).
 *
 * `initial` (a preset's option groups) seeds a group's JSON in place of its defaults, and
 * `initialRemotes` the remotes doc; resets still go back to the defaults.
 *
 * Group defs must be static — they are captured on first render.
 */
export function useOptionGroups<K extends string>({
    groups,
    withRemotes = false,
    initial,
    initialRemotes,
}: {
    groups: readonly OptionGroupDef<K>[]
    withRemotes?: boolean
    initial?: Partial<Record<K, Record<string, FlagValue> | undefined>>
    initialRemotes?: Record<string, Record<string, FlagValue>>
}) {
    // Defs are static per page — freeze the first-render value so effects don't depend on an
    // inline-array identity. The seed likewise: it is read once, on mount.
    const [defs] = useState(groups)
    const [seed] = useState(initial)

    const [jsonStrings, setJsonStrings] = useState<Record<K, string>>(
        () => Object.fromEntries(defs.map((g) => [g.key, '{}'])) as Record<K, string>
    )
    const [parsed, setParsed] = useState<Record<K, Record<string, FlagValue>>>(
        () =>
            Object.fromEntries(defs.map((g) => [g.key, {}])) as Record<K, Record<string, FlagValue>>
    )
    const [locked, setLockedMap] = useState<Record<K, boolean>>(
        () => Object.fromEntries(defs.map((g) => [g.key, false])) as Record<K, boolean>
    )

    // The remotes group replicates the old two-stage pipeline exactly:
    //   tab strings -> (all-or-nothing parse) -> remoteDocParsed -> (gated on group validity)
    //   -> remoteParsed (the args source).
    // remoteDocParsed is the old "outer doc": the last successful full parse of the tab strings.
    // Reset clears IT (not the strings), so tabs keep their text, submits carry no remote
    // options, and the next tab edit re-parses everything back in — the old chain's behavior.
    const [remoteOptionsJson, setRemoteOptionsJson] = useState<Record<string, string>>({})
    const [remoteDocParsed, setRemoteDocParsed] = useState<
        Record<string, Record<string, FlagValue>>
    >(() => initialRemotes ?? {})
    const [remoteParsed, setRemoteParsed] = useState<Record<string, Record<string, FlagValue>>>(
        () => initialRemotes ?? {}
    )
    const [remoteLocked, setRemoteLocked] = useState(false)

    const [jsonError, setJsonError] = useState<K | null>(null)

    // Bumped by a forced (mount-time) reconcile so the groups parse effect re-runs even when the
    // rebuilt strings round-trip to a value-equal doc — replicating the old mount write-back
    // side-channel that re-latched jsonError on a still-invalid group after a remount.
    const [parseNonce, setParseNonce] = useState(0)

    // Seed the JSON strings on mount (the parse effect derives the values): a group's seed
    // where the preset carries one, its defaults otherwise. defs and seed are frozen on first
    // render, so this still runs exactly once.
    useEffect(() => {
        startTransition(() => {
            setJsonStrings((prev) => {
                const next = { ...prev }
                for (const g of defs) {
                    const value = seed?.[g.key] ?? g.defaults
                    if (value) {
                        next[g.key] = JSON.stringify(value, null, 2)
                    }
                }
                return next
            })
        })
    }, [defs, seed])

    // Parse effect: single try/catch over all groups so ANY invalid group freezes EVERY group's
    // parsed values until the user fixes the JSON. remoteDocParsed is a dep on purpose — the old
    // page effect re-parsed on outer-doc changes too, so a remote-tab edit while a group is
    // invalid re-throws and RE-LATCHES jsonError (re-disabling START), and the remotes args
    // source syncs to the doc only on a successful full parse.
    // biome-ignore lint/correctness/useExhaustiveDependencies: parseNonce is a deliberate re-run trigger the body doesn't read
    useEffect(() => {
        let step: K = defs[0].key
        try {
            const nextParsed = {} as Record<K, Record<string, FlagValue>>
            for (const g of defs) {
                step = g.key
                nextParsed[g.key] = JSON.parse(jsonStrings[g.key]) as Record<string, FlagValue>
            }

            startTransition(() => {
                setParsed(nextParsed)
                if (withRemotes) {
                    setRemoteParsed(remoteDocParsed)
                }
                setJsonError(null)
            })
        } catch (error) {
            setJsonError(step)
            console.error(`Error parsing ${step} options:`, error)
        }
    }, [defs, jsonStrings, remoteDocParsed, parseNonce, withRemotes])

    // Remotes parse — deliberately OUTSIDE the groups' try/catch: an invalid remote tab must NOT
    // set jsonError or disable start. Retention is ALL-OR-NOTHING across remotes: the loop
    // returns on the first invalid entry, freezing the doc for EVERY remote until the user fixes
    // the tab (a valid edit in another tab does not reach submit meanwhile). The value-equality
    // bailout mirrors the old write-back's identical-string setState bailout.
    useEffect(() => {
        if (!withRemotes) {
            return
        }
        const next: Record<string, Record<string, FlagValue>> = {}
        for (const [remote, json] of Object.entries(remoteOptionsJson)) {
            try {
                next[remote] = JSON.parse(json) as Record<string, FlagValue>
            } catch {
                return
            }
        }
        startTransition(() => {
            setRemoteDocParsed((prev) =>
                JSON.stringify(prev) === JSON.stringify(next) ? prev : next
            )
        })
    }, [remoteOptionsJson, withRemotes])

    // Stable per-group setters (defs are static). Returning `prev` unchanged on a same-value
    // write preserves React's Object.is bailout the dedicated useState setters had — a no-op
    // write must not re-run the parse effect.
    const setters = useMemo(() => {
        const map = {} as Record<
            K,
            { setJsonString: (value: string) => void; setLocked: (value: boolean) => void }
        >
        for (const g of defs) {
            map[g.key] = {
                setJsonString: (value: string) =>
                    setJsonStrings((prev) =>
                        prev[g.key] === value ? prev : { ...prev, [g.key]: value }
                    ),
                setLocked: (value: boolean) =>
                    setLockedMap((prev) =>
                        prev[g.key] === value ? prev : { ...prev, [g.key]: value }
                    ),
            }
        }
        return map
    }, [defs])

    const groupStates = useMemo(() => {
        const map = {} as Record<K, OptionGroupState>
        for (const g of defs) {
            map[g.key] = {
                options: parsed[g.key],
                jsonString: jsonStrings[g.key],
                setJsonString: setters[g.key].setJsonString,
                locked: locked[g.key],
                setLocked: setters[g.key].setLocked,
            }
        }
        return map
    }, [defs, parsed, jsonStrings, locked, setters])

    // Count-change semantics (mirrors the old length-equality init guard): when the remote COUNT
    // changes in EITHER direction, rebuild ALL tabs' strings from the last-valid parsed doc —
    // pruning deselected remotes, seeding new ones with '{}', and discarding mid-edit invalid
    // text. Same-count changes deliberately do not rebuild — EXCEPT on `force`, which the view
    // passes on its first call after (re)mounting: the old tab strings were child state destroyed
    // on unmount, so a remount always rebuilt from the doc regardless of the count.
    const reconcileRemotes = useCallback(
        (remoteNames: string[], force = false) => {
            startTransition(() => {
                if (force) {
                    // A remount must re-run the groups parse once regardless of whether the
                    // rebuild changes anything (see parseNonce).
                    setParseNonce((n) => n + 1)
                }
                setRemoteOptionsJson((prev) => {
                    if (!force && Object.keys(prev).length === remoteNames.length) {
                        return prev
                    }
                    const next: Record<string, string> = {}
                    let changed = remoteNames.length !== Object.keys(prev).length
                    for (const remote of remoteNames) {
                        const lastValid = remoteDocParsed[remote]
                        next[remote] =
                            lastValid !== undefined ? JSON.stringify(lastValid, null, 2) : '{}'
                        if (next[remote] !== prev[remote]) {
                            changed = true
                        }
                    }
                    return changed ? next : prev
                })
            })
        },
        [remoteDocParsed]
    )

    const remotes: RemoteOptionsGroupState = useMemo(
        () => ({
            options: remoteParsed,
            json: remoteOptionsJson,
            setJson: setRemoteOptionsJson,
            reconcile: reconcileRemotes,
            locked: remoteLocked,
            setLocked: setRemoteLocked,
        }),
        [remoteParsed, remoteOptionsJson, reconcileRemotes, remoteLocked]
    )

    // Template load writes the JSON-STRING state (the parse effect derives parsed values); merge
    // spreads the incoming group over the current PARSED values, exactly as the pages did.
    const applyTemplate = useCallback(
        (groupedOptions: Record<string, unknown>, shouldMerge: boolean) => {
            startTransition(() => {
                setJsonStrings((prev) => {
                    let changed = false
                    const next = { ...prev }
                    for (const g of defs) {
                        const incoming = groupedOptions[g.templateKey ?? g.key] as
                            | Record<string, FlagValue>
                            | undefined
                        // Truthiness only (as the pages did): groupByCategory always returns
                        // objects, so replace mode rewrites every group — clearing uncovered
                        // ones to '{}'.
                        if (!incoming) {
                            continue
                        }
                        const serialized = JSON.stringify(
                            shouldMerge ? { ...parsed[g.key], ...incoming } : incoming,
                            null,
                            2
                        )
                        if (next[g.key] !== serialized) {
                            next[g.key] = serialized
                            changed = true
                        }
                    }
                    // Same-value bailout as the pages' individual setters had.
                    return changed ? next : prev
                })
            })
        },
        [defs, parsed]
    )

    // Spread of all parsed groups in defs order (remotes excluded) — the TemplatesDropdown
    // getOptions source.
    const getMergedOptions = useCallback((): Record<string, FlagValue> => {
        const merged: Record<string, FlagValue> = {}
        for (const g of defs) {
            Object.assign(merged, parsed[g.key])
        }
        return merged
    }, [defs, parsed])

    // Restore every group's JSON string to its default (and remotes to '{}'), clearing jsonError.
    const resetJson = useCallback(() => {
        setJsonStrings((prev) => {
            let changed = false
            const next = { ...prev }
            for (const g of defs) {
                const value = g.defaults ? JSON.stringify(g.defaults, null, 2) : '{}'
                if (next[g.key] !== value) {
                    next[g.key] = value
                    changed = true
                }
            }
            return changed ? next : prev
        })
        if (withRemotes) {
            // Reset clears only the DOC (and, via stage 2, the args source) and leaves the tab
            // strings untouched — the old chain's exact behavior: after a reset the tabs still
            // display their text, submits carry no remote options, and the next edit in any tab
            // re-parses everything back in. Clearing the strings here would instead trigger a
            // reconcile rebuild from the stale doc, undoing the reset.
            setRemoteDocParsed({})
        }
        setJsonError(null)
    }, [defs, withRemotes])

    const resetLocks = useCallback(() => {
        setLockedMap((prev) => {
            if (defs.every((g) => prev[g.key] === false)) {
                return prev
            }
            return Object.fromEntries(defs.map((g) => [g.key, false])) as Record<K, boolean>
        })
        setRemoteLocked(false)
    }, [defs])

    return {
        jsonError,
        setJsonError,
        groups: groupStates,
        remotes,
        applyTemplate,
        getMergedOptions,
        resetJson,
        resetLocks,
    }
}
