import { t } from '@lingui/core/macro'
import { useCallback, useEffect, useRef } from 'react'
import { ask, currentWindow } from '../../lib/shell'

export function confirmLeave(): Promise<boolean> {
    return ask(t`Leave without saving your changes?`, {
        title: t`Unsaved changes`,
        kind: 'warning',
        okLabel: t({ message: 'Leave', comment: 'Button: closes without saving the changes.' }),
        cancelLabel: t({ message: 'Stay', comment: 'Button: keeps editing the unsaved changes.' }),
    })
}

export function useUnsavedChanges(edited: boolean): {
    confirm: () => Promise<boolean>
    forget: () => void
} {
    const state = useRef({ edited, forgotten: false, holding: false })
    state.current.edited = edited
    useEffect(() => {
        const s = state.current
        s.forgotten = false
        if (!edited) return
        s.holding = true
        hold()
        return () => {
            if (!s.holding) return
            s.holding = false
            release()
        }
    }, [edited])
    const confirm = useCallback(async () => {
        const s = state.current
        if (!s.edited || s.forgotten) return true
        return confirmLeave()
    }, [])
    const forget = useCallback(() => {
        const s = state.current
        s.forgotten = true
        if (!s.holding) return
        s.holding = false
        release()
    }, [])
    return { confirm, forget }
}

let held = 0
let listening = false
let asking = false
let calls: Promise<unknown> = Promise.resolve()

function guard(on: boolean) {
    calls = calls.then(() => currentWindow.guardClose(on)).catch(() => undefined)
}

function hold() {
    held += 1
    if (held > 1) return
    guard(true)
    if (listening) return
    listening = true
    currentWindow.onCloseAsked(async () => {
        if (asking) return
        if (held > 0) {
            asking = true
            const leave = await confirmLeave()
            asking = false
            if (!leave) return
        }
        guard(false)
        await calls
        await currentWindow.close()
    })
}

function release() {
    held -= 1
    if (held === 0) guard(false)
}
