import { t } from '@lingui/core/macro'
import type { Option, OptionValue, useFlags } from '../../../lib/catalog'
import { compareText } from '../../../lib/format'
import type { OptionCategory } from './OptionsAccordion'

export type GroupKey =
    | 'copy'
    | 'move'
    | 'sync'
    | 'bisync'
    | 'mount'
    | 'vfs'
    | 'serve'
    | 'filter'
    | 'config'
    | 'metadata'

export type Flags = ReturnType<typeof useFlags>

type Values = Record<string, OptionValue>

export interface OptionGroup {
    category: OptionCategory
    available(f: Flags, serveType?: string): Option[]
    global(f: Flags, serveType?: string): Values
}

const main = (f: Flags): Values => f.globalFlags?.main ?? {}

function serveAvailable(f: Flags, serveType?: string): Option[] {
    if (serveType) return f.serveFlags[serveType] ?? []
    const unique = new Map<string, Option>()
    for (const option of Object.values(f.serveFlags).flat()) {
        if (!unique.has(option.name)) unique.set(option.name, option)
    }
    return [...unique.values()].sort((a, b) => compareText(a.name, b.name))
}

function serveGlobal(f: Flags, serveType?: string): Values {
    if (serveType) return f.globalFlags?.[serveType] ?? {}
    return Object.assign({}, ...f.serveTypes.map((type) => f.globalFlags?.[type] ?? {}))
}

export const OPTION_GROUPS: Record<GroupKey, OptionGroup> = {
    copy: { category: 'copy', available: (f) => f.copyFlags ?? [], global: main },
    move: { category: 'move', available: (f) => f.copyFlags ?? [], global: main },
    sync: { category: 'sync', available: (f) => f.syncFlags ?? [], global: main },
    bisync: { category: 'bisync', available: (f) => f.copyFlags ?? [], global: main },
    mount: {
        category: 'mount',
        available: (f) => f.mountFlags ?? [],
        global: (f) => f.globalFlags?.mount ?? {},
    },
    vfs: {
        category: 'vfs',
        available: (f) => f.vfsFlags ?? [],
        global: (f) => f.globalFlags?.vfs ?? {},
    },
    serve: { category: 'serve', available: serveAvailable, global: serveGlobal },
    filter: {
        category: 'filters',
        available: (f) => f.filterFlags ?? [],
        global: (f) => f.globalFlags?.filter ?? {},
    },
    config: { category: 'config', available: (f) => f.configFlags ?? [], global: main },
    metadata: {
        category: 'metadata',
        available: (f) => f.metadataFlags ?? [],
        global: (f) => ({ ...f.globalFlags?.main, ...f.globalFlags?.filter }),
    },
}

function isGroupKey(name: string): name is GroupKey {
    return Object.hasOwn(OPTION_GROUPS, name)
}

export function invalidJsonText(name: string): string {
    if (!isGroupKey(name)) {
        const remote = name
        return t`The options of ${remote} aren't valid JSON`
    }
    switch (name) {
        case 'copy':
            return t`The copy options aren't valid JSON`
        case 'move':
            return t`The move options aren't valid JSON`
        case 'sync':
            return t`The sync options aren't valid JSON`
        case 'bisync':
            return t`The bisync options aren't valid JSON`
        case 'mount':
            return t`The mount options aren't valid JSON`
        case 'vfs':
            return t`The VFS options aren't valid JSON`
        case 'serve':
            return t`The serve options aren't valid JSON`
        case 'filter':
            return t`The filter options aren't valid JSON`
        case 'config':
            return t`The config options aren't valid JSON`
        default:
            return t`The metadata options aren't valid JSON`
    }
}

export function fixOptionsText(group: string): string | undefined {
    if (group === 'remotes') return t`Fix the remotes' options`
    if (!isGroupKey(group)) return undefined
    switch (group) {
        case 'copy':
            return t`Fix the copy options`
        case 'move':
            return t`Fix the move options`
        case 'sync':
            return t`Fix the sync options`
        case 'bisync':
            return t`Fix the bisync options`
        case 'mount':
            return t`Fix the mount options`
        case 'vfs':
            return t`Fix the VFS options`
        case 'serve':
            return t`Fix the serve options`
        case 'filter':
            return t`Fix the filter options`
        case 'config':
            return t`Fix the config options`
        default:
            return t`Fix the metadata options`
    }
}
