// The app's windows. On the desktop every operation is its own native window (opened through
// the shell's bridge); in a browser tab "open a window" is "go to its route" inside the Shell.

import { capabilities } from './host'
import { native, windowClose, windowHide } from './native'
import { navigate, setBusy } from './navigation'

export async function openFullWindow({
    name,
    url,
    hideTitleBar = false,
}: {
    name: string
    url: string
    hideTitleBar?: boolean
}) {
    console.log('[openFullWindow]', name)
    if (!capabilities.window) return navigate(url)
    await native('window_open', { name, route: url, kind: 'full', hideTitleBar })
}

export async function openWindow({
    name,
    url,
    width = 840,
    height = 725,
    newTab = false,
}: {
    name: string
    url: string
    width?: number
    height?: number
    /**
     * In a browser, open beside this page instead of replacing it (the desktop always opens a
     * window of its own). For a jump the user will want to come back from.
     */
    newTab?: boolean
}) {
    console.log('[openWindow] ', name, url)
    if (!capabilities.window) {
        // Straight from the click, before anything is awaited: a browser only lets a gesture
        // open a tab. A blocked popup falls back to going there. No `noopener` in the call:
        // with it `window.open` answers null either way, and blocked would look like opened.
        const tab = newTab ? window.open(url, '_blank') : null
        if (tab) {
            tab.opener = null
            return
        }
        return navigate(url)
    }
    // A window that is already open is focused, not reloaded; the shell sends it this route on
    // the bus (`window.route`) so the page can follow.
    await native('window_open', { name, route: url, kind: 'normal', width, height })
}

export async function openSmallWindow({ name, url }: { name: string; url: string }) {
    console.log('[openSmallWindow] ', name, url)
    if (!capabilities.window) return
    await native('window_open', { name, route: url, kind: 'small' })
}

export async function lockWindows(ids?: string[]) {
    if (!capabilities.window) return setBusy(true)
    await native('window_lock', { ids: ids ?? null })
}

export async function unlockWindows(ids?: string[]) {
    if (!capabilities.window) return setBusy(false)
    await native('window_unlock', { ids: ids ?? null })
}

/** Closes this window (desktop) or returns to the dashboard (browser). */
export async function closeSelf() {
    if (!capabilities.window) return navigate('/')
    await windowClose()
}

export async function hideSelf() {
    if (!capabilities.window) return
    await windowHide()
}
