// The router's `navigate` for code outside React. Set by the Shell once mounted; calls made
// before that are replayed.

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

/** A busy overlay counter: the Shell dims the page while it is above zero. */
let busy = 0
const busyListeners = new Set<(busy: boolean) => void>()

export function setBusy(locked: boolean) {
    busy = Math.max(0, busy + (locked ? 1 : -1))
    for (const listener of busyListeners) listener(busy > 0)
}

export function onBusy(listener: (busy: boolean) => void): () => void {
    busyListeners.add(listener)
    listener(busy > 0)
    return () => busyListeners.delete(listener)
}
