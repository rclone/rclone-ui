import { type ReactNode, useEffect, useRef } from 'react'

export function nativeName(tag: string) {
    try {
        const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag
        return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1)
    } catch {
        return tag
    }
}

export function englishName(tag: string) {
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag
    } catch {
        return tag
    }
}

const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** The canonical form of a language code, such as pt-BR, or "" for text that isn't one. */
export function validTag(text: string) {
    try {
        const [tag] = Intl.getCanonicalLocales(text.trim())
        return tag && LANGUAGE_TAG.test(tag) ? tag : ''
    } catch {
        return ''
    }
}

export const number = (n: number) => n.toLocaleString('en-US')
export const percent = (done: number, total: number) =>
    total ? Math.floor((done / total) * 100) : 0

const PATHS = {
    check: 'M4 10.5l3.5 3.5L16 5.5',
    warning: 'M10 3.5l7 12.5H3L10 3.5zM10 8.5v3.5M10 14.2v.1',
    search: 'M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM14 14l3.5 3.5',
    download: 'M10 3v10M5.5 9L10 13.5 14.5 9M4 16.5h12',
    upload: 'M10 13.5v-10M5.5 7.5L10 3l4.5 4.5M4 16.5h12',
    back: 'M12 4.5L6.5 10l5.5 5.5',
    next: 'M8 4.5l5.5 5.5L8 15.5',
    dot: 'M10 10h.01',
    close: 'M5 5l10 10M15 5L5 15',
    book: 'M4 4.5h4.5A1.5 1.5 0 0 1 10 6v10a1.5 1.5 0 0 0-1.5-1.5H4zM16 4.5h-4.5A1.5 1.5 0 0 0 10 6v10a1.5 1.5 0 0 1 1.5-1.5H16z',
    undo: 'M7 6.5H12a4 4 0 0 1 0 8H8M7 6.5L9.5 4M7 6.5L9.5 9',
    copy: 'M7 7V4.5h8.5V13H13M4.5 7H13v8.5H4.5z',
    gear: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
} as const

const SIZE = /(^|\s)size-/

export function Icon({ name, className = '' }: { name: keyof typeof PATHS; className?: string }) {
    const size = SIZE.test(className) ? '' : 'size-4'
    return (
        <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 ${size} ${className}`}
            aria-hidden="true"
        >
            <path d={PATHS[name]} />
        </svg>
    )
}

const BUTTON =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[background-color,color,box-shadow,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt'

export const buttons = {
    primary: `${BUTTON} bg-cobalt px-3.5 py-2 text-sm text-white shadow-[0_1px_0_rgb(0_0_0/0.08),inset_0_1px_0_rgb(255_255_255/0.15)] hover:bg-cobalt/90 dark:text-paper`,
    secondary: `${BUTTON} bg-panel px-3 py-2 text-sm text-ink shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.04)] hover:bg-paper`,
    ghost: `${BUTTON} px-2 py-1 text-[13px] text-graphite hover:bg-line/60 hover:text-ink`,
}

/** A modal dialog, open while `open` is true. Escape and the backdrop close it. */
export function Dialog({
    open,
    onClose,
    title,
    children,
    wide = false,
}: {
    open: boolean
    onClose: () => void
    title: string
    children: ReactNode
    wide?: boolean
}) {
    const ref = useRef<HTMLDialogElement>(null)
    useEffect(() => {
        const d = ref.current
        if (!d) return
        if (open && !d.open) d.showModal()
        if (!open && d.open) d.close()
    }, [open])
    return (
        <dialog
            ref={ref}
            onClose={onClose}
            onClick={(e) => {
                if (e.target === ref.current) onClose()
            }}
            className={`m-auto w-[calc(100%-2rem)] rounded-2xl bg-panel p-0 text-ink shadow-[0_0_0_1px_var(--line),0_24px_48px_-12px_rgb(0_0_0/0.25)] backdrop:bg-black/40 backdrop:backdrop-blur-[2px] ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        >
            {open && (
                <div className="flex max-h-[85vh] flex-col">
                    <div className="flex items-center justify-between gap-4 border-line border-b px-5 py-3.5">
                        <h2 className="font-semibold text-base">{title}</h2>
                        <button
                            type="button"
                            className={buttons.ghost}
                            onClick={onClose}
                            aria-label="Close"
                        >
                            <Icon name="close" />
                        </button>
                    </div>
                    <div className="overflow-y-auto px-5 py-4">{children}</div>
                </div>
            )}
        </dialog>
    )
}

// The parts of a text that are not words: values, the structure of a count, tags and Go's verbs.
const ICU_TOKENS =
    /(\{\w+\}|\{\w+,\s*(?:plural|select|selectordinal|number|date|time),?\s*|(?:zero|one|two|few|many|other|=\d+)\s*\{|\}|#|<\/?\d+\/?>)/g
const ICU_PLAIN_TOKENS = /(\{\w+\}|<\/?\d+\/?>)/g
const COUNT = /\{\w+,\s*(?:plural|select|selectordinal)/
const VALUE = /^(?:\{\w+\}|%.+)$/
const TAG = /^<\/?\d+\/?>$/
const GO_TOKENS = /(%(?:\[\d+\])?[-+# 0]*\d*(?:\.\d+)?[a-zA-Z%])/g

export type Syntax = 'icu' | 'go' | 'plain'

function tokens(text: string, syntax: Syntax) {
    if (syntax === 'plain') return [text]
    if (syntax === 'go') return text.split(GO_TOKENS)
    return text.split(COUNT.test(text) ? ICU_TOKENS : ICU_PLAIN_TOKENS)
}

/**
 * Shows a text as it is written, with its values and tags as chips. A chip that the translation
 * needs can be clicked to put it in.
 */
export function Highlight({
    text,
    syntax,
    onPick,
}: {
    text: string
    syntax: Syntax
    onPick?: (token: string) => void
}) {
    const parts = tokens(text, syntax)
    return (
        <>
            {parts.map((part, i) => {
                if (!part) return null
                const key = `${i}:${part}`
                if (i % 2 === 0) return <span key={key}>{part}</span>
                const value = VALUE.test(part)
                const tag = TAG.test(part)
                if ((value || tag) && part !== '%%' && onPick) {
                    return (
                        <button
                            key={key}
                            type="button"
                            title={
                                tag
                                    ? 'Text with its own style, such as a link. Click to put it in.'
                                    : 'Click to put it in'
                            }
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => onPick(part)}
                            className="mx-px cursor-copy rounded-[5px] bg-plum-soft px-1 font-mono text-[0.82em] text-plum transition-[box-shadow] hover:shadow-[0_0_0_1px_var(--plum)]"
                        >
                            {part}
                        </button>
                    )
                }
                return (
                    <span key={key} className="font-mono text-[0.82em] text-plum">
                        {part}
                    </span>
                )
            })}
        </>
    )
}
