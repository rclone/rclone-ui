import { useEffect, useSyncExternalStore } from 'react'

/**
 * Not Alt: many Linux desktops use Alt with a click to move the window, and on Windows releasing
 * Alt alone moves the keyboard to the window's menu.
 */
const PEEK_KEY = 'Shift'

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

export function watchPeekKey(target: Pick<Window, 'addEventListener' | 'removeEventListener'>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
        clearTimeout(timer)
        timer = undefined
        setPeeking(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== PEEK_KEY) {
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
    target.addEventListener('blur', stop)
    return () => {
        target.removeEventListener('keydown', onKeyDown, true)
        target.removeEventListener('keyup', onKeyUp, true)
        target.removeEventListener('blur', stop)
        stop()
    }
}

export function usePeekKey() {
    useEffect(() => watchPeekKey(window), [])
}
