import type { LauncherKey } from '../../../lib/shell'

/** A digit or a full stop, which run rows and stop everything with Ctrl. */
const ROW_CHAR = /[0-9.]/

export interface KeyPress {
    key: string
    ctrl: boolean
    alt: boolean
    meta: boolean
    shift: boolean
    /** An input method is composing text, and keeps the keys it uses: Enter commits, the arrows choose. */
    composing: boolean
}

/**
 * What a key press does: a key for the launcher, 'swallow' for a key that does nothing, or null
 * for a key that the query box keeps. The launcher gets Up, Down, Enter, Esc and Tab, Ctrl+K for
 * the actions panel, and Ctrl with a digit, a full stop or one of rowLetters to run a row or stop
 * everything. Ctrl with any other letter, such as Ctrl+C or Ctrl+Z, stays with the box. Shift+Tab
 * is swallowed, because the box is the only thing that can take the keyboard.
 */
export function keyAction(
    press: KeyPress,
    rowLetters: string
): { key: LauncherKey; char?: string } | 'swallow' | null {
    if (press.composing) return null
    switch (press.key) {
        case 'ArrowUp':
            return { key: 'up' }
        case 'ArrowDown':
            return { key: 'down' }
        case 'Enter':
            return { key: 'enter' }
        case 'Escape':
            return { key: 'esc' }
        case 'Tab':
            return press.shift ? 'swallow' : { key: 'tab' }
        default:
            break
    }
    if (!press.ctrl || press.alt || press.meta) return null
    const c = press.key.toLowerCase()
    if (c === 'k') return { key: 'actions' }
    if (c.length === 1 && (ROW_CHAR.test(c) || rowLetters.includes(c)))
        return { key: 'row', char: c }
    return null
}

/**
 * The row at height y, measured from the window's top, or -1. A group label isn't part of its row,
 * and neither is the part of a row below the list's bottom.
 */
export function rowAt(y: number, rowTops: number[], rowH: number, listBottom: number): number {
    if (y >= listBottom) return -1
    return rowTops.findIndex((top) => y >= top && y < top + rowH)
}

/**
 * Turns wheel and touchpad movement into rows. A wheel click is one row. Pixels add up a row at a
 * time, rowH pixels each. It returns the whole rows to scroll and the remainder to keep.
 */
export function wheelRows(
    carried: number,
    deltaY: number,
    deltaMode: number,
    rowH: number
): { rows: number; carried: number } {
    // DOM_DELTA_LINE moves three lines a click, and DOM_DELTA_PAGE a page a click.
    const amount = deltaMode === 1 ? deltaY / 3 : deltaMode === 2 ? deltaY : deltaY / rowH
    const total = carried + amount
    const rows = Math.trunc(total)
    return { rows, carried: total - rows }
}
