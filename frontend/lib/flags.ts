import type { FlagValue } from '../types/rclone'
import { SERVE_TYPES } from './rclone/constants'

const RE_DASH = /-/g

// Options rclone accepts in a job's `_config` and then does not apply to that job. `options/info`
// lists the process's options and says nothing of this, so the list is ours, measured on rclone
// 1.75.1. They are not offered on the operation pages, and a template or a pasted command
// drops them.
export const NOT_PER_OPERATION: ReadonlySet<string> = new Set([
    // One budget for the whole process: Settings › Rclone.
    'bwlimit',
    'tpslimit',
    'tpslimit_burst',
    // Read once, when rclone starts.
    'log_level',
    'max_buffer_memory',
    // The command line's retry loop: a job started over rc has none.
    'retries',
    'retries_sleep',
    // A remote's HTTP client and pacer, built by whichever call opens the remote first and kept
    // while it stays cached. Browsing opens it, so an operation's value is never the one used,
    // and the first one given sticks to every later job.
    'user_agent',
    'timeout',
    'contimeout',
    'expect_continue_timeout',
    'no_gzip_encoding',
    'no_check_certificate',
    'ca_cert',
    'client_cert',
    'client_key',
    'client_pass',
    'disable_http2',
    'disable_http_keep_alives',
    'http_proxy',
    'use_cookies',
    'low_level_retries',
    'max_connections',
])

export const FLAG_CATEGORIES = [
    'copy',
    'sync',
    'config',
    'vfs',
    'filter',
    'mount',
    'metadata',
    ...SERVE_TYPES.map((type) => `serve.${type}` as const),
] as const

/**
 * The tags a template can carry. Tags name operations, so the per-type serve categories collapse
 * into one `serve` entry and `metadata` (an option section, not an operation) is left out.
 */
export const TEMPLATE_TAG_OPTIONS = [
    ...FLAG_CATEGORIES.filter((c) => !c.startsWith('serve.') && c !== 'metadata'),
    'serve',
] as const

function returnFlag(
    category: (typeof FLAG_CATEGORIES)[number],
    flag: string
): { category: (typeof FLAG_CATEGORIES)[number]; flag: string } {
    return {
        category,
        flag,
    }
}

export function getFlagCategory(
    flag: string,
    flags: Record<string, { Name: string; Groups?: string }[]>
) {
    console.log('[getFlagCategory] flag', flag)
    const normalizedFlag = (flag.startsWith('--') ? flag.slice(2) : flag).replace(RE_DASH, '_')

    console.log('[getFlagCategory] normalized flag', normalizedFlag)
    if (NOT_PER_OPERATION.has(normalizedFlag)) return null
    let foundFlag = null

    foundFlag = flags.main.find((f) => f.Name === normalizedFlag)

    if (foundFlag) {
        if (foundFlag.Groups?.includes('Metadata')) {
            return returnFlag('metadata', normalizedFlag)
        }
        if (foundFlag.Groups?.includes('Copy')) {
            return returnFlag('copy', normalizedFlag)
        }
        if (foundFlag.Groups?.includes('Sync')) {
            return returnFlag('sync', normalizedFlag)
        }
        return returnFlag('config', normalizedFlag)
    }

    foundFlag = flags.vfs.find((f) => f.Name === normalizedFlag)
    if (foundFlag) {
        return returnFlag('vfs', normalizedFlag)
    }

    foundFlag = flags.filter.find((f) => f.Name === normalizedFlag)
    if (foundFlag) {
        if (foundFlag.Groups?.includes('Metadata')) {
            return returnFlag('metadata', normalizedFlag)
        }
        return returnFlag('filter', normalizedFlag)
    }

    foundFlag = flags.mount.find((f) => f.Name === normalizedFlag)
    if (foundFlag) {
        return returnFlag('mount', normalizedFlag)
    }

    for (const serveType of SERVE_TYPES) {
        foundFlag = flags[serveType].find((f) => f.Name === normalizedFlag)
        if (foundFlag) {
            return returnFlag(`serve.${serveType}`, normalizedFlag)
        }
    }

    return null
}

/**
 * Resolves a flag's option definition using the SAME blocks and priority order as getFlagCategory
 * (main, vfs, filter, mount, then the serve backends), so a flag is typed from the exact block it
 * will later be grouped into. Blocks getFlagCategory never routes to (rc, log, proxy) are excluded
 * so a flag that also lives there can't be mis-typed or spuriously matched.
 */
export function findFlagOption(
    flag: string,
    allFlags: Record<string, { Name: string; Type?: string; Groups?: string }[]>
) {
    const normalizedFlag = (flag.startsWith('--') ? flag.slice(2) : flag).replace(RE_DASH, '_')
    const blocks = [
        allFlags.main,
        allFlags.vfs,
        allFlags.filter,
        allFlags.mount,
        ...SERVE_TYPES.map((type) => allFlags[type]),
    ]
    for (const block of blocks) {
        const found = block?.find((f) => f.Name === normalizedFlag)
        if (found) return found
    }
    return undefined
}

export function sortByName(flag1: { Name: string }, flag2: { Name: string }) {
    return flag1.Name.localeCompare(flag2.Name)
}

export const getOptionsSubtitle = (count: number) =>
    count > 0 ? `${count} option${count !== 1 ? 's' : ''} set` : undefined

export const getJsonKeyCount = (json: string) => {
    try {
        const parsed = JSON.parse(json) as Record<string, unknown>
        return Object.keys(parsed).length
    } catch {
        return 0
    }
}

export function groupByCategory(
    flags: Record<string, FlagValue>,
    allFlags: Record<string, { Name: string; Groups?: string }[]>
) {
    const collectedFlags = {
        mount: {} as Record<string, FlagValue>,
        config: {} as Record<string, FlagValue>,
        vfs: {} as Record<string, FlagValue>,
        filter: {} as Record<string, FlagValue>,
        copy: {} as Record<string, FlagValue>,
        sync: {} as Record<string, FlagValue>,
        metadata: {} as Record<string, FlagValue>,
        serve: {
            ...SERVE_TYPES.reduce(
                (acc, type) => {
                    acc[type] = {}
                    return acc
                },
                {} as Record<(typeof SERVE_TYPES)[number], Record<string, FlagValue>>
            ),
        },
    }

    for (const [k, v] of Object.entries(flags)) {
        const normalizedKey = k.replace(RE_DASH, '_')
        const category = getFlagCategory(k, allFlags)
        if (!category) continue
        if (category.category.startsWith('serve.')) {
            const serveType = category.category.slice(6) as (typeof SERVE_TYPES)[number]
            collectedFlags.serve[serveType] = {
                ...collectedFlags.serve[serveType],
                [normalizedKey]: v,
            }
            continue
        }
        collectedFlags[category.category as keyof Omit<typeof collectedFlags, 'serve'>] = {
            ...collectedFlags[category.category as keyof Omit<typeof collectedFlags, 'serve'>],
            [normalizedKey]: v,
        }
    }

    return collectedFlags
}
