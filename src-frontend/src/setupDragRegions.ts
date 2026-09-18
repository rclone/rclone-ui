// Native window dragging for the desktop's undecorated title-bar areas. Every non-interactive
// element gets `data-drag-region`; a pointerdown inside one asks the shell to start dragging
// the window (Tauri's own `data-tauri-drag-region` needs its IPC, which pages served over http
// don't have).

import { windowStartDragging } from '../lib/api/native'

const DRAG_ATTRIBUTE = 'data-drag-region'
const DRAGGING_ATTRIBUTE = 'data-dragging'
const INTERACTIVE_TAGS = new Set([
    'button',
    'input',
    'textarea',
    'select',
    'option',
    'label',
    'checkbox',
    'radio',
    'svg',
    'path',
    'a',
])

let initialized = false
let pointerListenersAttached = false

function isInteractive(element: Element): boolean {
    return INTERACTIVE_TAGS.has(element.tagName.toLowerCase())
}

function applyDragAttribute(root: Element) {
    const stack: Element[] = [root]

    while (stack.length > 0) {
        const element = stack.pop() as Element

        if (isInteractive(element)) {
            element.removeAttribute(DRAG_ATTRIBUTE)
            continue
        }

        element.setAttribute(DRAG_ATTRIBUTE, '')

        let child = element.firstElementChild
        while (child) {
            stack.push(child)
            child = child.nextElementSibling
        }
    }
}

function observeBody(body: HTMLElement) {
    applyDragAttribute(body)

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof Element) {
                    applyDragAttribute(node)
                }
            }
        }
    })

    observer.observe(body, { childList: true, subtree: true })
}

function isDragRegionEvent(event: PointerEvent): boolean {
    if (!(event.target instanceof Element)) {
        return false
    }

    const region = event.target.closest(`[${DRAG_ATTRIBUTE}]`)
    if (!region) {
        return false
    }

    if (typeof event.composedPath === 'function') {
        const path = event.composedPath()
        for (const item of path) {
            if (item instanceof Element && isInteractive(item)) {
                return false
            }
            if (item === region) {
                break
            }
        }
    } else if (isInteractive(event.target)) {
        return false
    }

    return true
}

function attachPointerListeners() {
    if (pointerListenersAttached) {
        return
    }

    const root = document.documentElement

    const clearDraggingState = () => {
        root.removeAttribute(DRAGGING_ATTRIBUTE)
    }

    const handlePointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !isDragRegionEvent(event)) {
            clearDraggingState()
            return
        }

        root.setAttribute(DRAGGING_ATTRIBUTE, 'true')
        windowStartDragging().catch(() => {})
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('pointerup', clearDraggingState, true)
    window.addEventListener('pointercancel', clearDraggingState, true)
    window.addEventListener('blur', clearDraggingState)

    pointerListenersAttached = true
}

export function initDragRegions(): void {
    if (initialized) {
        return
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return
    }

    const start = () => {
        const { body } = document
        if (!body) {
            return
        }

        observeBody(body)
        attachPointerListeners()
        initialized = true
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true })
    } else {
        start()
    }
}
