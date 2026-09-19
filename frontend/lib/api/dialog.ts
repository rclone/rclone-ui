// Dialogs, all rendered in the page (src/components/DialogHost.tsx).

import { enqueue } from './dialogs'

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
