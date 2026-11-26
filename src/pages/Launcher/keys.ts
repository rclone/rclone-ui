import type { LauncherKey } from '../../../lib/shell'

const ROW_CHAR = /[0-9.]/

export interface KeyPress {
    key: string
    ctrl: boolean
    alt: boolean
    meta: boolean
    shift: boolean
    composing: boolean
}

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

export function rowAt(y: number, rowTops: number[], rowH: number, listBottom: number): number {
    if (y >= listBottom) return -1
    return rowTops.findIndex((top) => y >= top && y < top + rowH)
}

const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const LINES_PER_WHEEL_CLICK = 3

export function wheelRows(
    carried: number,
    deltaY: number,
    deltaMode: number,
    rowH: number
): { rows: number; carried: number } {
    const amount =
        deltaMode === DOM_DELTA_LINE
            ? deltaY / LINES_PER_WHEEL_CLICK
            : deltaMode === DOM_DELTA_PAGE
              ? deltaY
              : deltaY / rowH
    const total = carried + amount
    const rows = Math.trunc(total)
    return { rows, carried: total - rows }
}
