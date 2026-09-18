import { winfspDownload } from '../api/app'
import { ask } from '../api/dialog'
import { platform } from '../api/os'
import { revealItem } from '../api/shell'
import { getFsInfo } from '../format'
import rclone from './client'
import { exists } from './daemon-fs'

// WinFsp on Windows is the only mount prerequisite the app checks (at mount time: the server's
// capability is a boot-time snapshot). macOS mounts through the system NFS client and Linux
// through the FUSE the distribution ships, so neither is checked.
const WINFSP_PATHS = ['C:\\Program Files\\WinFsp', 'C:\\Program Files (x86)\\WinFsp']

export async function needsMountPlugin() {
    console.log('[needsMountPlugin]')
    if (platform !== 'windows') return false
    for (const path of WINFSP_PATHS) {
        if (await exists(path).catch(() => false)) {
            console.log('[needsMountPlugin] found', path)
            return false
        }
    }
    console.log('[needsMountPlugin] WinFsp not found')
    return true
}

export async function dialogGetMountPlugin() {
    console.log('[dialogGetMountPlugin]')
    if (platform !== 'windows') return

    const wantsDownload = await ask(
        'WinFsp is required on Windows to mount remotes. You can continue the operation once you\'re done with the installation.\n\nIf you still see this message, download the WinFsp installer from Github and make sure you toggle "FUSE for Cygwin" during the installation process.',
        {
            title: 'WinFsp not installed',
            kind: 'warning',
            okLabel: 'Download',
            cancelLabel: 'Cancel',
        }
    )
    if (wantsDownload) {
        const localPath = await winfspDownload()
        await revealItem(localPath)
    }
}

export class AutomountSourceError extends Error {}

export async function probeMountSource(source: string) {
    const { root, filePath } = getFsInfo(source)

    if (!filePath) {
        await rclone('/operations/list', { params: { query: { fs: root, remote: '' } } })
        return
    }

    const r = await rclone('/operations/stat', {
        params: { query: { fs: root, remote: filePath } },
    })
    if (!r || !r.item) {
        throw new AutomountSourceError(
            `"${filePath}" was not found on ${root}. Fix the Remote Path in the remote's Auto Mount settings`
        )
    }
    if (!r.item.IsDir) {
        throw new AutomountSourceError(
            `"${filePath}" on ${root} is a file, not a folder. Fix the Remote Path in the remote's Auto Mount settings`
        )
    }
}

export async function listMountSource(source: string) {
    const { root, filePath } = getFsInfo(source)
    await rclone('/operations/list', { params: { query: { fs: root, remote: filePath } } })
}
