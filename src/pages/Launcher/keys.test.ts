import { describe, expect, test } from 'vitest'
import { type KeyPress, keyAction, rowAt, wheelRows } from './keys'

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
    key,
    ctrl: false,
    alt: false,
    meta: false,
    shift: false,
    composing: false,
    ...mods,
})
const letters = 'bdefgijlnoprstu'

describe('keyAction', () => {
    test('the launcher gets the moving and choosing keys', () => {
        expect(keyAction(press('ArrowDown'), letters)).toEqual({ key: 'down' })
        expect(keyAction(press('Enter'), letters)).toEqual({ key: 'enter' })
        expect(keyAction(press('Escape'), letters)).toEqual({ key: 'esc' })
        expect(keyAction(press('Tab'), letters)).toEqual({ key: 'tab' })
        expect(keyAction(press('Tab', { shift: true }), letters)).toBe('swallow')
    })

    test('Ctrl runs rows and opens the actions, but leaves editing keys to the box', () => {
        expect(keyAction(press('k', { ctrl: true }), letters)).toEqual({ key: 'actions' })
        expect(keyAction(press('3', { ctrl: true }), letters)).toEqual({ key: 'row', char: '3' })
        expect(keyAction(press('B', { ctrl: true, shift: true }), letters)).toEqual({
            key: 'row',
            char: 'b',
        })
        expect(keyAction(press('.', { ctrl: true }), letters)).toEqual({ key: 'row', char: '.' })
        for (const k of ['a', 'c', 'v', 'x', 'z', 'y']) {
            expect(keyAction(press(k, { ctrl: true }), letters)).toBeNull()
        }
        expect(keyAction(press('b', { ctrl: true, alt: true }), letters)).toBeNull()
    })

    test('an input method keeps every key while it composes', () => {
        expect(keyAction(press('Enter', { composing: true }), letters)).toBeNull()
        expect(keyAction(press('ArrowDown', { composing: true }), letters)).toBeNull()
    })

    test('typing stays in the box', () => {
        expect(keyAction(press('a'), letters)).toBeNull()
        expect(keyAction(press('Backspace'), letters)).toBeNull()
    })
})

test('rowAt finds the row under the pointer, but not a group label or the cut-off part', () => {
    // A row at 56, then a group label (24) and a row at 128, in a list that ends at 160.
    const tops = [56, 128]
    expect(rowAt(60, tops, 48, 160)).toBe(0)
    expect(rowAt(110, tops, 48, 160)).toBe(-1)
    expect(rowAt(130, tops, 48, 160)).toBe(1)
    expect(rowAt(165, tops, 48, 160)).toBe(-1)
})

test('wheelRows counts a wheel click as a row and adds up touchpad pixels', () => {
    expect(wheelRows(0, 3, 1, 48)).toEqual({ rows: 1, carried: 0 })
    const first = wheelRows(0, 30, 0, 48)
    expect(first.rows).toBe(0)
    expect(wheelRows(first.carried, 30, 0, 48).rows).toBe(1)
    expect(wheelRows(0, -96, 0, 48)).toEqual({ rows: -2, carried: 0 })
})
