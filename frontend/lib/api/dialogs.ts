// A serial queue of in-page dialog requests. Callers await their result; DialogHost renders the
// head of the queue and settles it. Plain module (no React) so any code can enqueue before the
// host has mounted — the request simply waits.

export type DialogRequest =
    | {
          kind: 'message'
          message: string
          title?: string
          level?: 'info' | 'warning' | 'error'
          /**
           * Button labels; `cancel` present ⇒ two buttons, `extra` ⇒ a third beside it for a
           * second way to act on the same thing. Resolves with the pressed label.
           */
          buttons: { ok: string; cancel?: string; extra?: string; second?: string }
          resolve: (label: string) => void
      }
    | {
          kind: 'prompt'
          title: string
          message: string
          defaultValue: string
          sensitive: boolean
          resolve: (value: string | null) => void
      }
    | {
          /**
           * A value to carry somewhere else and a value to bring back: the link is shown with a
           * Copy button and stays on screen while the answer is pasted in. Resolves with the
           * pasted text, or null if it was cancelled.
           */
          kind: 'handoff'
          title: string
          message: string
          link: string
          linkLabel: string
          inputLabel: string
          confirmLabel: string
          resolve: (value: string | null) => void
      }
    | {
          kind: 'open'
          title?: string
          directory: boolean
          multiple: boolean
          defaultPath?: string
          resolve: (paths: string | string[] | null) => void
      }
    | {
          kind: 'save'
          title?: string
          defaultPath?: string
          resolve: (path: string | null) => void
      }

type Listener = (queue: DialogRequest[]) => void

const queue: DialogRequest[] = []
const listeners = new Set<Listener>()

function notify() {
    for (const listener of listeners) listener([...queue])
}

export function enqueue<T extends DialogRequest>(request: T) {
    queue.push(request)
    notify()
}

/** Settles and removes the request at the head of the queue. */
export function settle(request: DialogRequest) {
    const index = queue.indexOf(request)
    if (index !== -1) queue.splice(index, 1)
    notify()
}

export function subscribe(listener: Listener): () => void {
    listeners.add(listener)
    listener([...queue])
    return () => listeners.delete(listener)
}
