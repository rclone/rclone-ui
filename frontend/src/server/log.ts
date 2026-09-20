// Mirrors the page console into the server's log file (batched `log` RPCs), so a bug report's
// log covers what the pages saw. Collected from the first line, sent once the page has a session
// (`startForwarding`): the RPC needs one, and on the screens before the app every line would be
// a refusal, and the refusal a reload to the login.

import { rpc } from './rpc'

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error'

const queue: { level: Level; message: string }[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let forwarding = false

function flush() {
    timer = null
    const batch = queue.splice(0, 200)
    const label = 'tab'
    for (const entry of batch) {
        rpc('log', { level: entry.level, message: entry.message, label }).catch(() => {})
    }
}

function enqueue(level: Level, message: string) {
    queue.push({ level, message })
    if (queue.length > 2000) queue.splice(0, queue.length - 2000)
    if (forwarding && !timer) timer = setTimeout(flush, 250)
}

/** Sends what was collected and everything from now on. The Shell calls it with a session in hand. */
export function startForwarding() {
    forwarding = true
    if (queue.length > 0 && !timer) timer = setTimeout(flush, 0)
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

/** Mirrors console methods at or above `minimum` (default: everything) into the server's log file. */
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
