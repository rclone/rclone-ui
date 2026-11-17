import { downloadDir } from '@tauri-apps/api/path'
import { ask } from '@tauri-apps/plugin-dialog'
import { exists, writeFile } from '@tauri-apps/plugin-fs'
import { fetch } from '@tauri-apps/plugin-http'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { platform } from '@tauri-apps/plugin-os'
import { getFsInfo } from '../format'
import rclone from './client'

export async function needsMountPlugin() {
    console.log('[needsMountPlugin]')

    const currentPlatform = platform()

    if (currentPlatform === 'windows') {
        // check winfsp
        const hasWinFsp =
            (await exists('C:\\Program Files\\WinFsp')) ||
            (await exists('C:\\Program Files (x86)\\WinFsp'))
        console.log('[needsMountPlugin] hasWinFsp', hasWinFsp)
        return !hasWinFsp
    }

    return false
}

export async function dialogGetMountPlugin() {
    console.log('[dialogGetMountPlugin]')

    const currentPlatform = platform()
    if (currentPlatform === 'windows') {
        // download winfsp
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
            const winFspInstallerUrl =
                'https://github.com/winfsp/winfsp/releases/download/v2.2B4/winfsp-2.2.26215.msi'
            const localPath = `${await downloadDir()}/winfsp-installer.msi`
            const installer = await (await fetch(winFspInstallerUrl)).arrayBuffer()
            await writeFile(localPath, new Uint8Array(installer))
            await revealItemInDir(localPath)
        }
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
