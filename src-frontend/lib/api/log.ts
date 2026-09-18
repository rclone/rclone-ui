// Mirrors the page console into the host's log file (batched `log` RPCs), so a bug report's
// log covers what the pages saw. Errors also go to Sentry from the page itself.

import { currentLabel } from './native'
import { rpc } from './rpc'

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error'

const queue: { level: Level; message: string }[] = []
let timer: ReturnType<typeof setTimeout> | null = null

function flush() {
    timer = null
    const batch = queue.splice(0, 200)
    const label = currentLabel() ?? 'tab'
    for (const entry of batch) {
        rpc('log', { level: entry.level, message: entry.message, label }).catch(() => {})
    }
}

function enqueue(level: Level, message: string) {
    queue.push({ level, message })
    if (queue.length > 2000) queue.splice(0, queue.length - 2000)
    if (!timer) timer = setTimeout(flush, 250)
}

function format(args: unknown[]): string {
    return args
        .map((arg) => {
            if (typeof arg === 'string') return arg
            if (arg instanceof Error) return arg.stack ?? arg.message
            try {
                return JSON.stringify(arg)
            } catch {
                return String(arg)
            }
        })
        .join(' ')
}

const ORDER: Level[] = ['trace', 'debug', 'info', 'warn', 'error']

/**
 * Mirrors console methods at or above `minimum` (default: everything) into the host's log file,
 * which rotates, so both the desktop's windows and browser tabs forward their whole console.
 */
export function forwardConsole(minimum: Level = 'trace') {
    const map: [keyof Console & ('log' | 'debug' | 'info' | 'warn' | 'error'), Level][] = [
        ['log', 'trace'],
        ['debug', 'debug'],
        ['info', 'info'],
        ['warn', 'warn'],
        ['error', 'error'],
    ]
    const floor = ORDER.indexOf(minimum)
    for (const [name, level] of map) {
        if (ORDER.indexOf(level) < floor) continue
        const original = console[name].bind(console)
        console[name] = (...args: unknown[]) => {
            original(...args)
            try {
                enqueue(level, format(args))
            } catch {}
        }
    }
}
