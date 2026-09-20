import { mountSupport } from '@/server/app'
import { ask } from '@/dialog'
import { openUrl } from '@/navigate'
import { getFsInfo } from '@/lib/format'
import rclone, { currentHostOs } from './client'

// Whether the machine can mount is the server's to say (WinFsp on Windows, /dev/fuse on Linux),
// and it looks every time it is asked: either can turn up while the server runs. Setting it up
// is the operator's; the page only says what is missing and where to read on.
export function mountSupportQueryOptions() {
    return {
        queryKey: ['mount', 'support'] as const,
        queryFn: mountSupport,
        staleTime: 0,
    }
}

/** After a mount failed: when the machine cannot mount, says why. Returns whether it did. */
export async function explainMountFailure(): Promise<boolean> {
    const support = await mountSupport().catch(() => null)
    if (!support || support.supported) return false
    const wantsDocs = await ask(
        `${support.reason}\n\nSet it up on the server, then start the mount again.`,
        {
            title: 'This server cannot mount',
            kind: 'warning',
            okLabel: currentHostOs() === 'windows' ? 'WinFsp on GitHub' : 'Open the docs',
            cancelLabel: 'Close',
        }
    )
    if (wantsDocs && support.docs) await openUrl(support.docs)
    return true
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
