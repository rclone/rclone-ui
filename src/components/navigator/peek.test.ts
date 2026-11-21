import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { isPeeking, watchPeekKey } from './peek'

let target: EventTarget
let stop: () => void

function key(type: 'keydown' | 'keyup', name: string, more: Partial<KeyboardEvent> = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), { key: name, ...more })
    target.dispatchEvent(event)
    return event
}

beforeEach(() => {
    vi.useFakeTimers()
    target = new EventTarget()
    stop = watchPeekKey(target as unknown as Window)
})

afterEach(() => {
    stop()
    vi.useRealTimers()
})

test('holding the key shows the labels, and releasing it hides them', () => {
    key('keydown', 'Shift')
    vi.advanceTimersByTime(150)
    expect(isPeeking()).toBe(false)
    vi.advanceTimersByTime(100)
    expect(isPeeking()).toBe(true)
    key('keyup', 'Shift')
    expect(isPeeking()).toBe(false)
})

test('a short press shows nothing', () => {
    key('keydown', 'Shift')
    vi.advanceTimersByTime(100)
    key('keyup', 'Shift')
    vi.advanceTimersByTime(500)
    expect(isPeeking()).toBe(false)
})

test('another key makes it a shortcut', () => {
    key('keydown', 'Shift')
    key('keydown', 'ArrowLeft', { shiftKey: true })
    vi.advanceTimersByTime(500)
    expect(isPeeking()).toBe(false)

    key('keyup', 'Shift')
    key('keydown', 'Shift')
    vi.advanceTimersByTime(250)
    expect(isPeeking()).toBe(true)
    key('keydown', 'Tab', { shiftKey: true })
    expect(isPeeking()).toBe(false)
})

test('the key with another modifier shows nothing', () => {
    key('keydown', 'Shift', { metaKey: true })
    vi.advanceTimersByTime(500)
    expect(isPeeking()).toBe(false)
})

test('losing the keyboard hides the labels', () => {
    key('keydown', 'Shift')
    vi.advanceTimersByTime(250)
    expect(isPeeking()).toBe(true)
    target.dispatchEvent(new Event('blur'))
    expect(isPeeking()).toBe(false)
})
