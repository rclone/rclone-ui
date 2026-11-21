import { t } from '@lingui/core/macro'
import type { Option, OptionValue, useFlags } from '../../../lib/catalog'
import { compareText } from '../../../lib/format'
import type { OptionCategory } from './OptionsAccordion'

// The option groups that the operation pages and the drawers edit, and where each one finds its
// options in the catalog. The defaults and the rule that sorts a template's options into groups
// live in the core, so this table only describes the groups. Each page lists the keys it shows,
// in its own order, and useOptionItems builds their accordion rows from here.

/** An option group that a page or a drawer edits, by its name in the form (Operations.Groups). */
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
    /** The tile, title and purpose of the group's accordion row (CATEGORY_META). */
    category: OptionCategory
    /** The options that the group's editor offers. */
    available(f: Flags, serveType?: string): Option[]
    /**
     * The app-wide values of the group's options that differ from rclone's defaults. An option
     * that the editor adds starts from them.
     */
    global(f: Flags, serveType?: string): Values
}

const main = (f: Flags): Values => f.globalFlags?.main ?? {}

/**
 * The serve options of `serveType`. Without a serve type, as in the template drawer, a template
 * can run as any serve, so every type's options are offered, each name once and sorted.
 */
function serveAvailable(f: Flags, serveType?: string): Option[] {
    if (serveType) return f.serveFlags[serveType] ?? []
    const unique = new Map<string, Option>()
    for (const option of Object.values(f.serveFlags).flat()) {
        if (!unique.has(option.name)) unique.set(option.name, option)
    }
    return [...unique.values()].sort((a, b) => compareText(a.name, b.name))
}

/** The app-wide values of `serveType`, or of every serve type merged when there is none. */
function serveGlobal(f: Flags, serveType?: string): Values {
    if (serveType) return f.globalFlags?.[serveType] ?? {}
    return Object.assign({}, ...f.serveTypes.map((type) => f.globalFlags?.[type] ?? {}))
}

export const OPTION_GROUPS: Record<GroupKey, OptionGroup> = {
    copy: { category: 'copy', available: (f) => f.copyFlags ?? [], global: main },
    // Move and bisync take the same options as copy. rclone has no lists of their own.
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
    // The metadata options are in rclone's main and filter blocks.
    metadata: {
        category: 'metadata',
        available: (f) => f.metadataFlags ?? [],
        global: (f) => ({ ...f.globalFlags?.main, ...f.globalFlags?.filter }),
    },
}

/** Whether a name is an option group's key, and not a remote's name. */
function isGroupKey(name: string): name is GroupKey {
    return Object.hasOwn(OPTION_GROUPS, name)
}

/**
 * What the action bar says while the JSON text of a group, or of a remote's tab, can't be parsed.
 * `name` is the group's key or the remote's name (useOptionGroups' `jsonError`).
 */
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

/**
 * What the action bar says while the core refuses an option of a group. `group` is the end of the
 * refused field (`options.config`). It is undefined for a group that this table doesn't know, and
 * the caller shows the core's own message.
 */
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
