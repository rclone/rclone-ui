import { useCallback, useMemo, useState } from 'react'
import { NOT_PER_OPERATION, findFlagOption, groupByCategory } from '@/lib/flags'
import { SERVE_TYPES } from '@/lib/rclone/constants'
import { parseFlagText } from '@/lib/rclone/optionTypes'
import type { BackendOption, FlagValue } from '@/lib/rclone/types'

// A template edited as eight JSON documents, one per option group, by the Add and Edit drawers
// alike: how a flat template becomes the eight, how the eight become a flat template again, and
// how a pasted command line becomes one.

export const TEMPLATE_GROUPS = [
    'mount',
    'config',
    'vfs',
    'filter',
    'copy',
    'sync',
    'serve',
    'metadata',
] as const
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number]
export type TemplateDraft = Record<TemplateGroup, string>

export const EMPTY_DRAFT: TemplateDraft = Object.fromEntries(
    TEMPLATE_GROUPS.map((group) => [group, '{}'])
) as TemplateDraft

type FlagIndex = Parameters<typeof groupByCategory>[1]

/** The eight groups' JSON from a template's flat options; the Serve groups (one per protocol) fold into one. */
export function draftFromOptions(
    options: Record<string, FlagValue>,
    allFlags: FlagIndex
): TemplateDraft {
    const grouped = groupByCategory(options, allFlags)
    const json = (value: unknown) => JSON.stringify(value, null, 2)
    return {
        mount: json(grouped.mount),
        config: json(grouped.config),
        vfs: json(grouped.vfs),
        filter: json(grouped.filter),
        copy: json(grouped.copy),
        sync: json(grouped.sync),
        serve: json(Object.assign({}, ...Object.values(grouped.serve))),
        metadata: json(grouped.metadata),
    }
}

/** The flat options a draft saves: later groups win, in `TEMPLATE_GROUPS` order. Throws on invalid JSON. */
export function optionsFromDraft(draft: TemplateDraft): Record<string, FlagValue> {
    return Object.assign(
        {},
        ...TEMPLATE_GROUPS.map((group) => JSON.parse(draft[group]) as Record<string, FlagValue>)
    )
}

const QUOTES = /^["'`]+|["'`]+$/g
const DASHES = /-/g
const WHITESPACE = /\s+/

/** The `--flags` of a pasted command line as flat options, typed by the flag index; nothing without flags. */
export function optionsFromCommand(
    command: string,
    allFlags: FlagIndex
): Record<string, FlagValue> {
    const flagsIndex = command.indexOf('--')
    // No flags at all: nothing to import (slice(-1) would "import" the last character).
    if (flagsIndex === -1) return {}
    const options: Record<string, FlagValue> = {}
    for (const piece of command.slice(flagsIndex).split('--').filter(Boolean)) {
        const [token, ...valueParts] = piece.trim().split(WHITESPACE)
        const equalsIndex = token.indexOf('=')
        const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex)
        const name = flag.replace(DASHES, '_')
        // Not counted as imported either: the draft would drop it.
        if (NOT_PER_OPERATION.has(name)) continue
        let value = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1)
        if (value === undefined && valueParts.length > 0) value = valueParts.join(' ')
        if (value !== undefined) value = value.replace(QUOTES, '')
        const parsed = parseFlagText(value, findFlagOption(name, allFlags)?.Type)
        const previous = options[name]
        options[name] =
            Array.isArray(previous) && Array.isArray(parsed) ? [...previous, ...parsed] : parsed
    }
    return options
}

/** The Serve tab's flag lists: every protocol's flags once, and their global defaults merged. */
export function serveFlagsForTemplates(
    serveFlags: Record<string, BackendOption[]> | undefined,
    globalFlags: Record<string, unknown> | undefined
) {
    const unique = new Map<string, BackendOption>()
    for (const flag of Object.values(serveFlags ?? {}).flat()) {
        if (!unique.has(flag.Name)) unique.set(flag.Name, flag)
    }
    const merged: Record<string, unknown> = {}
    if (globalFlags) {
        for (const type of SERVE_TYPES) Object.assign(merged, globalFlags[type] ?? {})
    }
    return {
        uniqueServeFlags: Array.from(unique.values()).sort((a, b) => a.Name.localeCompare(b.Name)),
        mergedGlobalServeFlags: merged,
    }
}

/** The draft with one stable setter per group, a replace for imports and seeds, and a reset. */
export function useTemplateDraft(initial: TemplateDraft = EMPTY_DRAFT) {
    const [draft, setDraft] = useState<TemplateDraft>(initial)
    const setters = useMemo(
        () =>
            Object.fromEntries(
                TEMPLATE_GROUPS.map((group) => [
                    group,
                    (json: string) => setDraft((prev) => ({ ...prev, [group]: json })),
                ])
            ) as Record<TemplateGroup, (json: string) => void>,
        []
    )
    const replace = useCallback((next: TemplateDraft) => setDraft(next), [])
    const reset = useCallback(() => setDraft(EMPTY_DRAFT), [])
    return { draft, setters, replace, reset }
}
