import { plural } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { FlagValue } from '../types/rclone'
import { catalog as api } from './core/api'
import { coreKey } from './core/query'
import type { OperationName } from './operations'
import {
    type Backend,
    Kind,
    Option,
    Path,
    type Section,
} from './shell/bindings/github.com/rclone/rclone-ui/core/catalog/models'

export type { Backend }
export { Kind, Option, Path }

// rclone's reference data comes from the core's catalog: the backends, the global option blocks,
// and the groups of options that the pages offer. The data only changes with the version of
// rclone, so it is fetched once.

export function useCatalog() {
    return useQuery({
        queryKey: coreKey('catalog', 'Get'),
        queryFn: () => api.Get(),
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
    })
}

/** The app's default options for an operation, by option group. A group without defaults is missing. */
export type GroupDefaults = Readonly<Partial<Record<string, Readonly<Record<string, FlagValue>>>>>

const NO_DEFAULTS: GroupDefaults = {}

/**
 * The app's default options for an operation, by option group, or undefined until the catalog
 * arrives. The core applies them under every run (see components/operation/defaults.ts). Without
 * an operation there are none, as in the template drawer, whose template holds only the user's
 * own options.
 */
export function useOperationDefaults(operation?: OperationName): GroupDefaults | undefined {
    const defaults = useCatalog().data?.defaults
    if (!operation) return NO_DEFAULTS
    return defaults
        ? ((defaults[operation] as GroupDefaults | undefined) ?? NO_DEFAULTS)
        : undefined
}

/**
 * Every backend that rclone has, by name, without their options (useBackendOptions fetches
 * those). Hidden backends are included, because a saved remote may use one.
 */
export function useBackends(): Backend[] | undefined {
    const backends = useCatalog().data?.backends
    return backends
}

/**
 * A backend's options, as rclone's config asks for them for a remote of `type` with the given
 * `provider`. The core applies rclone's provider rule (fs.MatchProvider), so the result holds only
 * the options for that provider, each with only its own choices. Without a provider, the provider
 * option's default is used. If there is no default either, only the options that every provider
 * has are returned.
 *
 * Returns undefined until the first result arrives. While the options for another provider of the
 * same backend load, the previous result stays, so the form doesn't empty out when the provider
 * changes.
 */
export function useBackendOptions(
    type: string | undefined,
    provider: string | undefined
): Option[] | undefined {
    return useProviderOptions(type, provider).options
}

/**
 * useBackendOptions, and whether the options are the ones for this type and provider. They aren't
 * while the first result loads, or while the previous provider's options stand in for them.
 */
export function useProviderOptions(
    type: string | undefined,
    provider: string | undefined
): { options: Option[] | undefined; current: boolean } {
    const { data, isPlaceholderData } = useQuery({
        ...backendQuery(type, provider),
        placeholderData: (previous) =>
            previous && isBackend(previous.backend, type) ? previous : undefined,
    })
    const backend = type && isBackend(data?.backend, type) ? data?.backend : undefined
    return { options: backend?.options, current: !!backend && !isPlaceholderData }
}

/**
 * The query for a backend's options for a provider. It stays idle without a type. It is exported
 * so that useQueries can run it for several remotes at once.
 */
export function backendQuery(type: string | undefined, provider: string | undefined) {
    const input = { type: type ?? '', provider: provider ?? '' }
    return {
        queryKey: coreKey('catalog', 'Backend', input),
        queryFn: () => api.Backend(input.type, input.provider),
        enabled: !!type,
        staleTime: Number.POSITIVE_INFINITY,
        // A backend that rclone doesn't have won't appear on a second try.
        retry: false,
    }
}

/** Whether b is the backend that a remote's `type` names, by its name or one of its aliases. */
function isBackend(b: Backend | null | undefined, type: string | undefined): boolean {
    return !!b && !!type && (b.name === type || b.aliases.includes(type))
}

/** An option's value as the core returns it: rclone's text, or the elements of a list option. */
export type OptionValue = string | string[]

/**
 * The global option values that differ from rclone's defaults, by block and then by rclone's
 * option name. Values are rclone's text ("5m0s", "16Mi", "off"), and lists are given as their
 * elements. The core reads lists from rclone's own value, so no text is split here. An option
 * that a page adds starts from these values.
 */
export function useOptionValues(): Record<string, Record<string, OptionValue>> | undefined {
    const { data } = useQuery({
        queryKey: coreKey('catalog', 'Values'),
        queryFn: () => api.Values(),
    })
    return useMemo(() => {
        if (!data) return undefined
        return Object.fromEntries(
            Object.entries(data.blocks).map(([block, v]) => [
                block,
                {
                    ...(v?.text as Record<string, string> | undefined),
                    ...Object.fromEntries(
                        Object.entries(v?.lists ?? {}).map(([name, list]) => [
                            name,
                            list?.values ?? [],
                        ])
                    ),
                },
            ])
        )
    }, [data])
}

const SERVE = 'serve.'

/** The serve types on this machine (nfs is Unix only). The catalog has a group for each one. */
function serveTypesOf(groups: Section[] | undefined): string[] {
    return (groups ?? [])
        .filter((g) => g.name.startsWith(SERVE))
        .map((g) => g.name.slice(SERVE.length))
}

/**
 * The option lists that the pages offer, one for each catalog group, with each serve's list
 * keyed by its type. It also returns the groups themselves, and `globalFlags`, the values that an
 * option starts from when a page adds it. The lists are undefined until the catalog arrives.
 */
export function useFlags() {
    const { data } = useCatalog()
    const globalFlags = useOptionValues()
    const groups = data?.groups
    const lists = useMemo(() => {
        if (!data || !groups) return undefined
        const blocks = new Map(data.blocks.map((b) => [b.name, b.options]))
        return Object.fromEntries(
            groups.map((g) => [
                g.name,
                g.options
                    .map((ref) => blocks.get(ref.block)?.find((o) => o.name === ref.name))
                    .filter((o): o is Option => !!o),
            ])
        )
    }, [data, groups])
    return useMemo(() => {
        const serveTypes = serveTypesOf(groups)
        return {
            groups,
            globalFlags,
            filterFlags: lists?.filter,
            configFlags: lists?.config,
            mountFlags: lists?.mount,
            vfsFlags: lists?.vfs,
            copyFlags: lists?.copy,
            syncFlags: lists?.sync,
            metadataFlags: lists?.metadata,
            serveTypes,
            serveFlags: Object.fromEntries(
                serveTypes.map((t) => [t, lists?.[`${SERVE}${t}`] ?? []])
            ) as Record<string, Option[]>,
        }
    }, [groups, lists, globalFlags])
}

/** Option values, grouped by catalog group (filter, config, copy, serve.http…). */
export type GroupedOptions = Record<string, Record<string, FlagValue>>

/**
 * A template's flat options, sorted by the core into the catalog's groups (catalog.SortOptions).
 * Every serve type's group gets the serve options. `skipped` lists the options that no group
 * takes. Idle without options.
 */
export function useSortedOptions(options: Record<string, FlagValue> | undefined) {
    return useQuery({
        queryKey: coreKey('catalog', 'SortOptions', { options }),
        queryFn: () => api.SortOptions(options ?? {}, ''),
        enabled: !!options,
        staleTime: Number.POSITIVE_INFINITY,
    })
}

/** Every serve's options in one object, because the template drawers edit them in one section. */
export function serveOptions(grouped: GroupedOptions): Record<string, FlagValue> {
    return Object.assign(
        {},
        ...Object.entries(grouped)
            .filter(([name]) => name.startsWith(SERVE))
            .map(([, values]) => values)
    )
}

/**
 * Parses a pasted rclone command line (`rclone sync a: b: --transfers 8 -P`) in the core, using
 * rclone's own flags. Returns `groups`, the options it sets sorted into catalog groups, and
 * `skipped`, the flags that no group takes, each with a reason. Idle while `command` is empty.
 */
export function useParsedCommand(command: string) {
    return useQuery({
        queryKey: coreKey('catalog', 'ParseCommand', { command }),
        queryFn: () => api.ParseCommand(command),
        enabled: !!command,
        staleTime: Number.POSITIVE_INFINITY,
        // If rclone can't read the line, it won't on a second try either.
        retry: false,
        select: (res) => ({
            groups: Object.fromEntries(
                Object.entries(res.groups ?? {}).map(([group, options]) => [group, options ?? {}])
            ),
            skipped: res.skipped ?? [],
        }),
    })
}

export const getOptionsSubtitle = (count: number) =>
    count > 0 ? plural(count, { one: '# option set', other: '# options set' }) : undefined

export const getJsonKeyCount = (json: string) => {
    try {
        return Object.keys(JSON.parse(json) as Record<string, unknown>).length
    } catch {
        return 0
    }
}
