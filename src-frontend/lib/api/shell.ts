// Opening things outside the app. URLs open in the user's own browser. Paths live on the
// machine the server runs on: a native window opens them there (it is the same machine); a
// browser tab, which may be anywhere, is shown the location instead and can copy it.

import { writeText } from './clipboard'
import { message } from './dialog'
import { capabilities } from './host'
import { rpc } from './rpc'

export async function openUrl(url: string): Promise<void> {
    if (capabilities.window) {
        await rpc('open_url', { url })
        return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
}

async function showLocation(path: string, what: string): Promise<void> {
    const pressed = await message(path, {
        title: `${what} on the server`,
        kind: 'info',
        buttons: { ok: 'Copy path', cancel: 'Close' },
    })
    if (pressed === 'Copy path') {
        await writeText(path)
    }
}

/** Opens a file or folder with its default application on the host. */
export async function openPath(path: string): Promise<void> {
    if (!capabilities.window) {
        await showLocation(path, 'Location')
        return
    }
    await rpc('open_path', { path })
}

/** Reveals a path in the host's file manager. */
export async function revealItem(path: string): Promise<void> {
    if (!capabilities.window) {
        await showLocation(path, 'File location')
        return
    }
    await rpc('reveal_item', { path })
}
