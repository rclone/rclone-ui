import { t } from '@lingui/core/macro'
import { useCallback } from 'react'
import { reportError } from '../../../lib/errors'
import { prompt } from '../../../lib/shell'
import { makeFolder } from './fsActions'
import type { RemoteString } from './types'
import { newFolderPath, panelFolder } from './utils'

/** The NEW button. Creates a folder in the panel's folder (not in Favorites or the disk list). */
export default function useCreateFolder(remote: RemoteString, cwd: string) {
    const canCreateFolder = panelFolder(remote, cwd) !== null

    const createFolder = useCallback(async () => {
        if (!canCreateFolder) return

        const folderName = await prompt({
            title: t`New folder`,
            message: t`Enter a name for the new folder`,
            default: t({
                message: 'New folder',
                context: 'the name that a new folder starts with',
            }),
            sensitive: false,
        })
        const normalizedFolderName = folderName?.trim()
        if (!normalizedFolderName) return

        const target = newFolderPath(remote, cwd, normalizedFolderName)
        if (target === null) return
        try {
            await makeFolder(target)
        } catch (error) {
            await reportError(error, {
                title: t`Error`,
                fallback: t`Create folder failed`,
            })
        }
    }, [canCreateFolder, remote, cwd])

    return { canCreateFolder, createFolder }
}
