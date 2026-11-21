import { type GroupedOptions, serveOptions } from '../../../lib/catalog'
import type { Catalog } from '../../../lib/core/types'
import type { FlagValue } from '../../../types/rclone'
import { optionName } from '../../components/operation/defaults'
import type { GroupKey } from '../../components/operation/optionGroups'

// A template is one flat object of options. The template drawer edits it in eight groups, each one
// a JSON text (useOptionGroups, without an operation, so the groups start without defaults).
// templateGroups splits options that the core sorted into the drawer's groups. A save merges the
// groups back together over the options that no group shows, so that an option the drawer doesn't
// offer (an unknown name, or `bwlimit`) is kept when the template is edited.
//
// A null in a template is an app default that it leaves out. A page sends only what differs from
// the defaults, and it sends a default that the user removed as a null (`difference` in
// defaults.ts). The core then runs without that default. No group's text can show a null, so the
// drawer keeps it with the options that no group shows, until a group sets that option again.

/** The groups of the template drawer, in the order it shows them and merges them on save. */
export const TEMPLATE_GROUPS = [
    'copy',
    'sync',
    'filter',
    'config',
    'metadata',
    'mount',
    'vfs',
    'serve',
] as const satisfies readonly GroupKey[]

export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number]

type Options = Record<string, FlagValue>

/** A template's options, where a null leaves out an app default. */
export type TemplateOptions = Record<string, FlagValue | null>

/**
 * The drawer's groups from options that the core sorted into the catalog's groups (a pasted
 * command, or catalog.SortOptions). The options of every serve go in one group, because a
 * template can run as any serve.
 */
export function templateGroups(grouped: GroupedOptions): Record<TemplateGroup, Options> {
    return Object.fromEntries(
        TEMPLATE_GROUPS.map((key) => [
            key,
            key === 'serve' ? serveOptions(grouped) : (grouped[key] ?? {}),
        ])
    ) as Record<TemplateGroup, Options>
}

/**
 * Splits the options of a template into the groups that the drawer edits, after the core sorted
 * them into the catalog's groups (`sorted`, from catalog.SortOptions). `rest` holds the options
 * that no group shows, which are kept on save (keptOf): the ones that the core skipped, and the
 * app defaults that the template leaves out (its nulls).
 */
export function seedTemplate(
    options: TemplateOptions,
    sorted: Pick<Catalog.Sorted, 'groups' | 'skipped'>
): { groups: Record<TemplateGroup, Options>; rest: TemplateOptions } {
    const grouped = Object.fromEntries(
        Object.entries(sorted.groups ?? {}).map(([name, values]) => [
            name,
            (values ?? {}) as Options,
        ])
    )
    const skipped = new Set((sorted.skipped ?? []).map((s) => s.flag))
    const rest = Object.fromEntries(
        Object.entries(options).filter(([key, value]) => skipped.has(key) || value === null)
    )
    return { groups: templateGroups(grouped), rest }
}

/**
 * What a save keeps of `rest`, given the options that the drawer's groups now hold: all of it,
 * except a left-out default that a group sets again, under any spelling. A group's option also
 * wins over a kept one of the same name, because the save spreads the groups last.
 */
export function keptOf(
    rest: TemplateOptions,
    groups: Readonly<Record<string, unknown>>
): TemplateOptions {
    const named = new Set(Object.keys(groups).map(optionName))
    return Object.fromEntries(
        Object.entries(rest).filter(([key, value]) => value !== null || !named.has(optionName(key)))
    )
}
