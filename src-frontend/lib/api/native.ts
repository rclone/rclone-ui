// The desktop shell's native bridge (`POST /api/native/<name>`): windows, the toolbar, the
// theme. Only meaningful when `capabilities.window` is true; every call is a no-op elsewhere.

import { windowInfo } from './boot'
import { capabilities } from './host'
import { sessionId } from './ws'

export class NativeError extends Error {}

export async function native<T = unknown>(
    name: string,
    args?: Record<string, unknown>
): Promise<T> {
    if (!capabilities.window) return null as T
    const response = await fetch(`/api/native/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RcloneUI-Session': sessionId },
        body: JSON.stringify(args ?? {}),
        credentials: 'same-origin',
    })
    const parsed = (await response.json()) as { ok: boolean; value?: T; error?: string }
    if (!parsed.ok) throw new NativeError(parsed.error ?? `${name} failed`)
    return parsed.value as T
}

/** This window's label (`Toolbar`, `Settings`, …) or `null` in a browser tab. */
export function currentLabel(): string | null {
    return windowInfo?.label ?? null
}

export const windowHide = (label = currentLabel()) => native<null>('window_hide', { label })
export const windowClose = (label = currentLabel()) => native<null>('window_close', { label })
export const windowFocus = (label = currentLabel()) => native<null>('window_focus', { label })
export const windowIsFocused = (label = currentLabel()) =>
    native<boolean>('window_is_focused', { label })
export const windowOuterPosition = (label = currentLabel()) =>
    native<{ x: number; y: number }>('window_outer_position', { label })
export const windowSetIgnoreCursorEvents = (ignore: boolean, label = currentLabel()) =>
    native<null>('window_set_ignore_cursor_events', { label, ignore })
export const windowStartDragging = (label = currentLabel()) =>
    native<null>('window_start_dragging', { label })
export const windowToggleMaximize = (label = currentLabel()) =>
    native<null>('window_toggle_maximize', { label })
export const windowSetTheme = (theme: 'light' | 'dark' | null) =>
    native<null>('window_set_theme', { theme })
export const windowExists = (label: string) => native<boolean>('window_exists', { label })
export const toolbarShow = () => native<null>('toolbar_show')
export const toolbarSetShortcut = (shortcut: string | null) =>
    native<null>('toolbar_set_shortcut', { shortcut })
