import type { Platform } from '../../../lib/shell'

/**
 * Keys that are named by their position rather than by the character they type: the punctuation
 * keys and Space.
 */
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

/** Modifier keys. A shortcut holds them down, but can't end with one. */
const MODIFIER_KEYS = ['Shift', 'Ctrl', 'Alt', 'AltGraph', 'Command']

export type ShortcutEvent = Pick<
    KeyboardEvent,
    'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

/**
 * Formats a pressed key combination the way the launcher shortcut setting stores it, such as
 * "Command+Shift+/" or "Alt+K". These are the names that `Accelerator` in
 * app/launcher/shortcut.go reads. Returns null while only modifiers are held down.
 *
 * A letter or digit is named by the character the keyboard layout types, so the A key on AZERTY
 * gives "A". When the modifiers turn the key into another character or into none, the key is
 * named by its position instead. For example, on a Mac Option+K types "˚" and Option+E is a dead
 * key, Shift+1 types "!", and a Cyrillic layout types its own letters.
 */
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

/** What the shortcut recorder should do with a keydown. */
export type RecorderKey =
    /** Escape: stop recording and keep the current shortcut. */
    | { kind: 'cancel' }
    /** Tab and Shift+Tab: let the page handle the key, so the focus moves. */
    | { kind: 'pass' }
    /** Only modifiers are held down so far. */
    | { kind: 'wait' }
    /** A key with no modifier, or only Shift. It would take that key away from every other app. */
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

/** The keycap labels of the modifiers on one OS, by their names in the setting, in lowercase. */
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

/**
 * Splits a shortcut such as "CmdOrCtrl+Shift+/" into the labels of its keycaps, as they are
 * named on the keyboards of `os` (⌘ ⇧ / on macOS, Ctrl Shift / elsewhere).
 */
export function keycaps(shortcut: string, os: Platform): string[] {
    const caps = modifierCaps(os)
    // "Ctrl++" ends with the plus key itself.
    const parts = shortcut.endsWith('++')
        ? [...shortcut.slice(0, -2).split('+'), '+']
        : shortcut.split('+')
    return parts.filter((part) => part !== '').map((part) => caps[part.toLowerCase()] ?? part)
}
