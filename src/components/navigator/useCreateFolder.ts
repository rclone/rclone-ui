import { invoke } from '@tauri-apps/api/core'
import { useCallback } from 'react'
import { reportError } from '../../../lib/errors'
import { getFsInfo } from '../../../lib/format'
import { fsInfoQueryOptions, hasFeature } from '../../../lib/hooks'
import queryClient from '../../../lib/query'
import { uploadEmptyFile } from '../../../lib/rclone/api'
import rclone from '../../../lib/rclone/client'
import type { RemoteString } from './types'
import { RE_TRAILING_SEPARATORS } from './utils'

export default function useCreateFolder(remote: RemoteString, cwd: string, refresh: () => void) {
    const canCreateFolder = !!remote && remote !== 'UI_FAVORITES'

    const createFolder = useCallback(async () => {
        if (!remote || remote === 'UI_FAVORITES') return

        const folderName = await invoke<string | null>('prompt', {
            title: 'New Folder',
            message: 'Enter a name for the new folder',
            default: 'New Folder',
            sensitive: false,
        })
        const normalizedFolderName = folderName?.trim()
        if (!normalizedFolderName) return

        try {
            const normalizedPath = cwd.replace(RE_TRAILING_SEPARATORS, '')
            const fullTargetPath =
                remote === 'UI_LOCAL_FS'
                    ? `${normalizedPath}${normalizedPath ? '/' : ''}${normalizedFolderName}`
                    : `${remote}:/${normalizedPath}${normalizedPath ? '/' : ''}${normalizedFolderName}`
            const info = getFsInfo(fullTargetPath)

            let supportsEmptyDirs = true
            if (remote !== 'UI_LOCAL_FS') {
                const fsInfo = await queryClient
                    .ensureQueryData(fsInfoQueryOptions(remote))
                    .catch(() => undefined)
                if (fsInfo) supportsEmptyDirs = hasFeature(fsInfo, 'CanHaveEmptyDirectories')
            }

            if (supportsEmptyDirs) {
                await rclone('/operations/mkdir' as any, {
                    params: {
                        query: {
                            fs: info.root === ':local:' ? ':local:/' : info.root,
                            remote: info.filePath,
                        },
                    },
                })
            } else {
                await uploadEmptyFile(info.root, info.filePath)
            }

            refresh()
        } catch (error) {
            await reportError(error, {
                title: 'Error',
                fallback: 'Create folder failed',
                capture: false,
            })
        }
    }, [remote, cwd, refresh])

    return { canCreateFolder, createFolder }
}
