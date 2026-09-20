// Dialogs, all rendered in the page (layouts/shell/DialogHost.tsx): a serial queue of requests,
// and the calls that enqueue one and await its answer. Plain module (no React) so any code can
// ask before the host has mounted — the request simply waits.

import { writeText } from './clipboard'

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

// --- the dialogs -----------------------------------------------------------------------------

export interface MessageOptions {
    title?: string
    kind?: 'info' | 'warning' | 'error'
    okLabel?: string
    /**
     * Custom labels; `cancel` adds a second button, `extra` a third and `second` a fourth. The
     * extras sit between cancel and ok, in that order.
     */
    buttons?: { ok?: string; cancel?: string; extra?: string; second?: string }
}

export interface AskOptions extends MessageOptions {
    cancelLabel?: string
}

/** A message with one button (two with `buttons.cancel`). Resolves with the pressed label. */
export function message(text: string, options?: MessageOptions): Promise<string> {
    return new Promise((resolve) => {
        enqueue({
            kind: 'message',
            message: text,
            title: options?.title,
            level: options?.kind,
            buttons: {
                ok: options?.buttons?.ok ?? options?.okLabel ?? 'Ok',
                cancel: options?.buttons?.cancel,
                extra: options?.buttons?.extra,
                second: options?.buttons?.second,
            },
            resolve,
        })
    })
}

/**
 * Hands a value over to be used elsewhere and takes one back — the sign-in link that has to be
 * opened on another machine, and the address that machine lands on. Resolves with the pasted
 * text, or null when cancelled.
 */
export function handoff(options: {
    title: string
    message: string
    link: string
    linkLabel: string
    inputLabel: string
    confirmLabel: string
}): Promise<string | null> {
    return new Promise((resolve) => {
        enqueue({ kind: 'handoff', ...options, resolve })
    })
}

/** Two-button question. Resolves `true` for the ok button. */
export function ask(text: string, options?: AskOptions): Promise<boolean> {
    return new Promise((resolve) => {
        const ok = options?.buttons?.ok ?? options?.okLabel ?? 'Yes'
        enqueue({
            kind: 'message',
            message: text,
            title: options?.title,
            level: options?.kind,
            buttons: { ok, cancel: options?.buttons?.cancel ?? options?.cancelLabel ?? 'No' },
            resolve: (label) => resolve(label === ok),
        })
    })
}

export const confirm = ask

export function prompt(options: {
    title: string
    message: string
    default?: string | null
    sensitive?: boolean
}): Promise<string | null> {
    return new Promise((resolve) => {
        enqueue({
            kind: 'prompt',
            title: options.title,
            message: options.message,
            defaultValue: options.default ?? '',
            sensitive: options.sensitive ?? false,
            resolve,
        })
    })
}

export interface PickOptions {
    title?: string
    directory?: boolean
    multiple?: boolean
    defaultPath?: string
}

/** A file/folder picker over the host's filesystem (PathSelector in a modal). */
export function pickPath(options: PickOptions & { multiple: true }): Promise<string[] | null>
export function pickPath(options?: PickOptions): Promise<string | null>
export function pickPath(options?: PickOptions): Promise<string | string[] | null> {
    return new Promise((resolve) => {
        enqueue({
            kind: 'open',
            title: options?.title,
            directory: options?.directory ?? false,
            multiple: options?.multiple ?? false,
            defaultPath: options?.defaultPath,
            resolve,
        })
    })
}

/** A "save as" picker: a folder plus a file name. */
export function saveAs(options?: {
    title?: string
    defaultPath?: string
}): Promise<string | null> {
    return new Promise((resolve) => {
        enqueue({ kind: 'save', title: options?.title, defaultPath: options?.defaultPath, resolve })
    })
}

/**
 * Where a file or folder lives on the server. Paths live on the machine the server runs on,
 * which may be anywhere, so the page shows the location and offers to copy it.
 */
export async function showLocation(path: string, what = 'Location'): Promise<void> {
    const pressed = await message(path, {
        title: `${what} on the server`,
        kind: 'info',
        buttons: { ok: 'Copy path', cancel: 'Close' },
    })
    if (pressed === 'Copy path') {
        await writeText(path)
    }
}
