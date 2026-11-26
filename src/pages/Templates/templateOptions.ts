import { type GroupedOptions, serveOptions } from '../../../lib/catalog'
import type { Catalog } from '../../../lib/core/types'
import type { FlagValue } from '../../../types/rclone'
import { optionName } from '../../components/operation/defaults'
import type { GroupKey } from '../../components/operation/optionGroups'

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

export type TemplateOptions = Record<string, FlagValue | null>

export function templateGroups(grouped: GroupedOptions): Record<TemplateGroup, Options> {
    return Object.fromEntries(
        TEMPLATE_GROUPS.map((key) => [
            key,
            key === 'serve' ? serveOptions(grouped) : (grouped[key] ?? {}),
        ])
    ) as Record<TemplateGroup, Options>
}

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

export function keptOf(
    rest: TemplateOptions,
    groups: Readonly<Record<string, unknown>>
): TemplateOptions {
    const named = new Set(Object.keys(groups).map(optionName))
    return Object.fromEntries(
        Object.entries(rest).filter(([key, value]) => value !== null || !named.has(optionName(key)))
    )
}
