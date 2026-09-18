// Opening things outside the page. URLs open in the browser. Paths live on the machine the
// server runs on, which may be anywhere, so the page shows the location and offers to copy it.

import { writeText } from './clipboard'
import { message } from './dialog'

export async function openUrl(url: string): Promise<void> {
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

/** Shows where a file or folder lives on the server. */
export async function openPath(path: string): Promise<void> {
    await showLocation(path, 'Location')
}

/** Shows where a path lives on the server. */
export async function revealItem(path: string): Promise<void> {
    await showLocation(path, 'File location')
}
