// The router's `navigate` for code outside React, set by the Shell once mounted (calls made
// before that are replayed), and the one way a URL is opened outside the page.

type Navigate = (to: string | number) => void

let navigateImpl: Navigate | null = null
const pending: (string | number)[] = []

export function setNavigate(navigate: Navigate | null) {
    navigateImpl = navigate
    if (navigate) {
        for (const to of pending.splice(0)) navigate(to)
    }
}

export function navigate(to: string | number) {
    if (navigateImpl) {
        navigateImpl(to)
    } else {
        pending.push(to)
    }
}

/** A new tab, with no handle back to this one. */
export function openUrl(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer')
}
