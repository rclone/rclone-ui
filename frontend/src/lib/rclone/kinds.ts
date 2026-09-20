import type { FlagValue } from '@/lib/rclone/types'
import { getFsInfo } from '@/lib/format'
import rclone from './client'
import { type Kinds, serializeOptions } from './requests'

/**
 * What each source is, from rclone: a file or a folder. One `operations/stat` per distinct
 * path, the same call every start made to say "does not exist" — now its answer is kept. A
 * trailing slash on the path is spelling the user chose (or not); it decides nothing here. A
 * root (`remote:`, `/`) answers as a folder like anything else.
 *
 * No try/catch: a transport failure must propagate as the real error instead of being masked
 * as "does not exist". A genuinely missing path returns a response with no item.
 */
export async function describeSources(
    paths: string[],
    options?: {
        configParam?: string
        remotes?: Record<string, Record<string, FlagValue>>
    }
): Promise<Kinds> {
    const kinds: Kinds = {}
    for (const path of new Set(paths)) {
        const { root, filePath, remoteName } = getFsInfo(path)
        const remoteOptions = options?.remotes?.[remoteName]
        const fs =
            remoteOptions && Object.keys(remoteOptions).length > 0
                ? serializeOptions(root, { remote: remoteOptions })
                : root
        const answer = await rclone('/operations/stat', {
            params: {
                query: {
                    fs,
                    remote: filePath,
                    ...(options?.configParam ? { _config: options.configParam } : {}),
                },
            },
        })
        const item = answer?.item as { IsDir?: boolean } | null | undefined
        if (!item) {
            throw new Error(`Source does not exist, ${path} is missing`)
        }
        kinds[path] = item.IsDir ? 'folder' : 'file'
    }
    return kinds
}
