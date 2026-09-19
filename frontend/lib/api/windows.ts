// "Open a window" is "go to its route": every page is a route in the same tab. The desktop's
// second window, its small overlays and its hide-me are not things a browser tab has, so what
// is left here is the route jump, the busy lock and the way back to the dashboard.

import { navigate, setBusy } from './navigation'

export async function openWindow({
    url,
}: {
    name: string
    url: string
    width?: number
    height?: number
}) {
    return navigate(url)
}

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
