import { describe, expect, it } from 'vitest'
import { formatShortcutFromEvent, keycaps, readRecorderKey, type ShortcutEvent } from './shortcut'

function press(key: string, code: string, mods: Partial<ShortcutEvent> = {}): ShortcutEvent {
    return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

describe('formatShortcutFromEvent', () => {
    it("names a letter Option turned into a symbol by the key's place", () => {
        expect(formatShortcutFromEvent(press('˚', 'KeyK', { altKey: true }))).toBe('Alt+K')
    })

    it("names a dead key by the key's place", () => {
        expect(formatShortcutFromEvent(press('Dead', 'KeyE', { altKey: true }))).toBe('Alt+E')
    })

    it('names punctuation by its place, whatever Shift types', () => {
        expect(
            formatShortcutFromEvent(press('?', 'Slash', { metaKey: true, shiftKey: true }))
        ).toBe('Command+Shift+/')
    })

    it('keeps the letter the layout types', () => {
        // On AZERTY, the A key is where Q is on QWERTY.
        expect(formatShortcutFromEvent(press('a', 'KeyQ', { ctrlKey: true }))).toBe('Ctrl+A')
    })

    it('names a digit Shift turned into a symbol by its place', () => {
        expect(formatShortcutFromEvent(press('!', 'Digit1', { shiftKey: true }))).toBe('Shift+1')
    })

    it('keeps a named key', () => {
        expect(formatShortcutFromEvent(press('ArrowUp', 'ArrowUp', { ctrlKey: true }))).toBe(
            'Ctrl+ArrowUp'
        )
    })

    it('waits while only modifiers are down', () => {
        expect(formatShortcutFromEvent(press('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull()
        expect(
            formatShortcutFromEvent(press('AltGraph', 'AltRight', { ctrlKey: true, altKey: true }))
        ).toBeNull()
    })
})

describe('readRecorderKey', () => {
    it('cancels on Escape, with or without modifiers', () => {
        expect(readRecorderKey(press('Escape', 'Escape'))).toEqual({ kind: 'cancel' })
        expect(readRecorderKey(press('Escape', 'Escape', { metaKey: true }))).toEqual({
            kind: 'cancel',
        })
    })

    it('leaves Tab and Shift+Tab to the page', () => {
        expect(readRecorderKey(press('Tab', 'Tab'))).toEqual({ kind: 'pass' })
        expect(readRecorderKey(press('Tab', 'Tab', { shiftKey: true }))).toEqual({ kind: 'pass' })
    })

    it('records Tab with Ctrl', () => {
        expect(readRecorderKey(press('Tab', 'Tab', { ctrlKey: true }))).toEqual({
            kind: 'shortcut',
            shortcut: 'Ctrl+Tab',
        })
    })

    it('waits while only modifiers are down', () => {
        expect(readRecorderKey(press('Meta', 'MetaLeft', { metaKey: true }))).toEqual({
            kind: 'wait',
        })
    })

    it('refuses a key alone or with only Shift', () => {
        expect(readRecorderKey(press('a', 'KeyA'))).toEqual({ kind: 'bare', shortcut: 'A' })
        expect(readRecorderKey(press('A', 'KeyA', { shiftKey: true }))).toEqual({
            kind: 'bare',
            shortcut: 'Shift+A',
        })
        expect(readRecorderKey(press('F5', 'F5'))).toEqual({ kind: 'bare', shortcut: 'F5' })
    })

    it('records a key with Command, Ctrl or Alt', () => {
        expect(readRecorderKey(press('?', 'Slash', { metaKey: true, shiftKey: true }))).toEqual({
            kind: 'shortcut',
            shortcut: 'Command+Shift+/',
        })
        expect(readRecorderKey(press('k', 'KeyK', { ctrlKey: true }))).toEqual({
            kind: 'shortcut',
            shortcut: 'Ctrl+K',
        })
        expect(readRecorderKey(press('˚', 'KeyK', { altKey: true }))).toEqual({
            kind: 'shortcut',
            shortcut: 'Alt+K',
        })
    })
})

describe('keycaps', () => {
    it("names a shortcut's keys as each system's keyboards do", () => {
        expect(keycaps('CmdOrCtrl+Shift+/', 'macos')).toEqual(['⌘', '⇧', '/'])
        expect(keycaps('CmdOrCtrl+Shift+/', 'windows')).toEqual(['Ctrl', 'Shift', '/'])
        expect(keycaps('Super+Space', 'linux')).toEqual(['Super', 'Space'])
        expect(keycaps('Ctrl++', 'windows')).toEqual(['Ctrl', '+'])
    })
})
