import { useCallback } from 'react'
import { reportError } from '../../../lib/errors'
import { getFsInfo } from '../../../lib/format'
import { fsInfoQueryOptions, hasFeature } from '../../../lib/hooks'
import queryClient from '../../../lib/query'
import { uploadEmptyFile } from '../../../lib/rclone/api'
import rclone from '../../../lib/rclone/client'
import { joinRemoteDir } from '../../../lib/paths'
import type { RemoteString } from './types'
import { RE_TRAILING_SEPARATORS, serializeRemotePath } from './utils'
import { prompt } from '../../../lib/api/dialog'

export default function useCreateFolder(remote: RemoteString, cwd: string, refresh: () => void) {
    const canCreateFolder = !!remote && remote !== 'UI_FAVORITES'

    const createFolder = useCallback(async () => {
        if (!remote || remote === 'UI_FAVORITES') return

        const folderName = await prompt({
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
                    : serializeRemotePath(
                          remote,
                          joinRemoteDir(normalizedPath, normalizedFolderName)
                      )
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
                            fs: info.root,
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
            })
        }
    }, [remote, cwd, refresh])

    return { canCreateFolder, createFolder }
}
