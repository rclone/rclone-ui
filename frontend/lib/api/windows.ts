// "Open a window" is "go to its route": every page is a route in the same tab, and a jump the
// user will want to come back from opens beside it instead.

import { navigate, setBusy } from './navigation'

export async function openFullWindow({ url }: { name: string; url: string; hideTitleBar?: boolean }) {
    return navigate(url)
}

export async function openWindow({
    url,
    newTab = false,
}: {
    name: string
    url: string
    width?: number
    height?: number
    /** Open beside this page instead of replacing it. */
    newTab?: boolean
}) {
    // Straight from the click, before anything is awaited: a browser only lets a gesture open a
    // tab. A blocked popup falls back to going there. No `noopener` in the call: with it
    // `window.open` answers null either way, and blocked would look like opened.
    const tab = newTab ? window.open(url, '_blank') : null
    if (tab) {
        tab.opener = null
        return
    }
    return navigate(url)
}

export async function openSmallWindow(_: { name: string; url: string }) {}

export async function lockWindows(_ids?: string[]) {
    setBusy(true)
}

export async function unlockWindows(_ids?: string[]) {
    setBusy(false)
}

/** Back to the dashboard. */
export async function closeSelf() {
    return navigate('/')
}

export async function hideSelf() {}
