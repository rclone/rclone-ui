import type { Platform } from '../../../lib/shell'

const KEY_CODE_DISPLAY_MAP: Record<string, string> = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: 'Space',
}

const ASCII_LETTER_OR_DIGIT = /^[a-z0-9]$/i
const LETTER_OR_DIGIT_CODE = /^(?:Key([A-Z])|Digit([0-9]))$/

const MODIFIER_KEYS = ['Shift', 'Ctrl', 'Alt', 'AltGraph', 'Command']

export type ShortcutEvent = Pick<
    KeyboardEvent,
    'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

export function formatShortcutFromEvent(event: ShortcutEvent): string | null {
    const modifiers: string[] = []
    if (event.metaKey) modifiers.push('Command')
    if (event.ctrlKey) modifiers.push('Ctrl')
    if (event.altKey) modifiers.push('Alt')
    if (event.shiftKey) modifiers.push('Shift')

    const physical = LETTER_OR_DIGIT_CODE.exec(event.code)
    let key =
        KEY_CODE_DISPLAY_MAP[event.code] ??
        (ASCII_LETTER_OR_DIGIT.test(event.key) ? event.key : undefined) ??
        (physical ? (physical[1] ?? physical[2]) : undefined) ??
        event.key

    if (key === 'Meta') {
        key = 'Command'
    } else if (key === 'Control') {
        key = 'Ctrl'
    } else if (key === ' ') {
        key = 'Space'
    } else if (key && key.length === 1) {
        key = key.toUpperCase()
    } else if (key) {
        key = key.charAt(0).toUpperCase() + key.slice(1)
    }

    if (!key || MODIFIER_KEYS.includes(key)) {
        return null
    }
    return [...modifiers, key].join('+')
}

export type RecorderKey =
    | { kind: 'cancel' }
    | { kind: 'pass' }
    | { kind: 'wait' }
    | { kind: 'bare'; shortcut: string }
    | { kind: 'shortcut'; shortcut: string }

export function readRecorderKey(event: ShortcutEvent): RecorderKey {
    if (event.key === 'Escape') {
        return { kind: 'cancel' }
    }
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        return { kind: 'pass' }
    }
    const shortcut = formatShortcutFromEvent(event)
    if (!shortcut) {
        return { kind: 'wait' }
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        return { kind: 'bare', shortcut }
    }
    return { kind: 'shortcut', shortcut }
}

function modifierCaps(os: Platform): Record<string, string> {
    const mac = os === 'macos'
    const meta = mac ? '⌘' : os === 'windows' ? 'Win' : 'Super'
    return {
        cmdorctrl: mac ? '⌘' : 'Ctrl',
        commandorcontrol: mac ? '⌘' : 'Ctrl',
        commandorctrl: mac ? '⌘' : 'Ctrl',
        cmdorcontrol: mac ? '⌘' : 'Ctrl',
        command: meta,
        cmd: meta,
        meta,
        super: meta,
        control: mac ? '⌃' : 'Ctrl',
        ctrl: mac ? '⌃' : 'Ctrl',
        alt: mac ? '⌥' : 'Alt',
        option: mac ? '⌥' : 'Alt',
        optionoralt: mac ? '⌥' : 'Alt',
        altgr: mac ? '⌥' : 'AltGr',
        shift: mac ? '⇧' : 'Shift',
    }
}

export function keycaps(shortcut: string, os: Platform): string[] {
    const caps = modifierCaps(os)
    const parts = shortcut.endsWith('++')
        ? [...shortcut.slice(0, -2).split('+'), '+']
        : shortcut.split('+')
    return parts.filter((part) => part !== '').map((part) => caps[part.toLowerCase()] ?? part)
}
