import { useEffect, useSyncExternalStore } from 'react'

/**
 * Peeking: while the user holds the peek key, the Commander shows labels that are normally only
 * seen on hover, such as the names of the places in its sidebars. Anything in the Commander can
 * call usePeek to show more while the key is held.
 */

/**
 * The key to hold. Shift works with a click, so the user can hold it, read the names and click
 * one. Alt doesn't: many Linux desktops use Alt with a click to move the window, and on Windows
 * releasing Alt alone moves the keyboard to the window's menu.
 */
const PEEK_KEY = 'Shift'

/**
 * How long the key must be held, in ms. A shorter press is the start of a shortcut or of a
 * capital letter, and shows nothing.
 */
const PEEK_DELAY = 200

let peeking = false
const listeners = new Set<() => void>()

function setPeeking(value: boolean) {
    if (value === peeking) return
    peeking = value
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/** Whether the peek key is held. */
export function usePeek(): boolean {
    return useSyncExternalStore(subscribe, isPeeking)
}

export function isPeeking() {
    return peeking
}

function isTyping(target: EventTarget | null) {
    return (
        typeof HTMLElement !== 'undefined' &&
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
    )
}

/** Listens for the peek key on a window, until the function it returns is called. */
export function watchPeekKey(target: Pick<Window, 'addEventListener' | 'removeEventListener'>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
        clearTimeout(timer)
        timer = undefined
        setPeeking(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== PEEK_KEY) {
            // Another key makes it a shortcut.
            stop()
            return
        }
        if (event.repeat || timer !== undefined || peeking) return
        if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return
        timer = setTimeout(() => {
            timer = undefined
            setPeeking(true)
        }, PEEK_DELAY)
    }
    const onKeyUp = (event: KeyboardEvent) => {
        if (event.key === PEEK_KEY) stop()
    }
    target.addEventListener('keydown', onKeyDown, true)
    target.addEventListener('keyup', onKeyUp, true)
    // The key's release goes to another window when this one loses the keyboard.
    target.addEventListener('blur', stop)
    return () => {
        target.removeEventListener('keydown', onKeyDown, true)
        target.removeEventListener('keyup', onKeyUp, true)
        target.removeEventListener('blur', stop)
        stop()
    }
}

/** Listens for the peek key. The Commander's page calls it once. */
export function usePeekKey() {
    useEffect(() => watchPeekKey(window), [])
}
