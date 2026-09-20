import { useCallback } from 'react'
import { ask, prompt } from '../../../lib/api/dialog'
import { reportError } from '../../../lib/errors'
import { getFsInfo } from '../../../lib/format'
import rclone from '../../../lib/rclone/client'
import type { Entry } from './types'
import { renamePath } from './utils'

/**
 * Rename and delete for a file panel's rows, the Commander's and the picker's alike: a name
 * prompt or a confirm, one rclone call, and `afterChange` for the caller to refresh its panels
 * (a picker also drops the entry from its selection).
 */
export default function useEntryActions(afterChange: (entry: Entry) => void) {
    const rename = useCallback(
        async (entry: Entry) => {
            const newName = await prompt({
                title: 'Rename',
                message: `Enter a new name for "${entry.name}"`,
                default: entry.name,
                sensitive: false,
            })
            if (!newName || newName === entry.name) return

            try {
                await renamePath(entry.fullPath, entry.isDir, newName)
                afterChange(entry)
            } catch (error) {
                await reportError(error, {
                    title: 'Error',
                    fallback: 'Rename failed',
                })
            }
        },
        [afterChange]
    )

    const remove = useCallback(
        async (entry: Entry) => {
            const confirmed = await ask(`Are you sure you want to delete "${entry.name}"?`, {
                title: 'Confirm Delete',
                kind: 'warning',
            })
            if (!confirmed) return

            try {
                const source = entry.fullPath + (entry.isDir ? '/' : '')
                const info = getFsInfo(source)
                const endpoint = entry.isDir ? '/operations/purge' : '/operations/deletefile'

                await rclone(endpoint as any, {
                    params: {
                        query: {
                            fs: info.root,
                            remote: info.filePath,
                        },
                    },
                })

                afterChange(entry)
            } catch (error) {
                await reportError(error, {
                    title: 'Error',
                    fallback: 'Delete failed',
                })
            }
        },
        [afterChange]
    )

    return { rename, remove }
}
