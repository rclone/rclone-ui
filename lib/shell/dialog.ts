// The pages' own dialogs: a queue of requests that DialogHost (src/components/DialogHost.tsx)
// shows one at a time, in order. message, ask, prompt and askOption in lib/shell add to it. Each
// window is its own page, so each window has its own queue and its own host. There is no React
// here, so any code can ask before the host has mounted.

import type { Option } from './bindings/github.com/rclone/rclone-ui/core/catalog/models'

export type DialogKind = 'info' | 'warning' | 'error'

export type DialogRequest =
    | {
          type: 'message'
          title: string
          message: string
          /** The colour of the OK button: primary, amber or red. */
          kind: DialogKind
          /** At most three buttons. Escape and closing choose Cancel, or OK when there is none. */
          buttons: { ok: string; cancel?: string; extra?: string }
          /** Whether OK deletes or discards something, which draws the dialog in red. */
          destructive?: boolean
          resolve: (label: string) => void
      }
    | {
          type: 'prompt'
          title: string
          message: string
          defaultValue: string
          /** Hides what is typed, for passwords. */
          sensitive: boolean
          resolve: (value: string | null) => void
      }
    | {
          type: 'option'
          title: string
          /** The option's help, which scripted answers match against. */
          message: string
          /** rclone's reason for asking again, or "". */
          notice: string
          /** The backend option that rclone asks for, drawn as the remote forms draw it. */
          option: Option
          resolve: (value: string | null) => void
      }

type Listener = (queue: DialogRequest[]) => void

const queue: DialogRequest[] = []
const listeners = new Set<Listener>()

function notify() {
    for (const listener of listeners) listener([...queue])
}

export function enqueue(request: DialogRequest) {
    queue.push(request)
    notify()
}

/** Takes a request off the queue, once it is answered. Its promise is resolved separately. */
export function settle(request: DialogRequest) {
    const index = queue.indexOf(request)
    if (index === -1) return
    queue.splice(index, 1)
    notify()
}

/** Calls back with the queue now and after every change. */
export function subscribe(listener: Listener): () => void {
    listeners.add(listener)
    listener([...queue])
    return () => {
        listeners.delete(listener)
    }
}

/**
 * Queues a request and resolves with its answer. When `signal` aborts, the dialog closes (or is
 * never shown) and the promise resolves with `aborted`.
 */
export function request<T>(
    make: (resolve: (value: T) => void) => DialogRequest,
    aborted: T,
    signal?: AbortSignal
): Promise<T> {
    if (signal?.aborted) return Promise.resolve(aborted)
    return new Promise<T>((resolve) => {
        const onAbort = () => {
            resolve(aborted)
            settle(req)
        }
        const req = make((value) => {
            signal?.removeEventListener('abort', onAbort)
            resolve(value)
        })
        signal?.addEventListener('abort', onAbort, { once: true })
        enqueue(req)
    })
}
