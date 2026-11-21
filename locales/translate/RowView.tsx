import { memo, useRef } from 'react'
import type { Problem } from './checks.ts'
import { withForms } from './plurals.ts'
import { isSetupFormat } from './rclone.ts'
import type { Row } from './types.ts'
import { buttons, Highlight, Icon, type Syntax } from './ui.tsx'

export type Status = 'todo' | 'done' | 'warn' | 'error'
export type Move = 'next' | 'prev' | 'todo'

const RAIL: Record<Status, string> = {
    todo: 'bg-line',
    done: 'bg-done',
    warn: 'bg-warn',
    error: 'bg-error',
}

export function syntaxOf(row: Row): Syntax {
    if (row.kind === 'app') return 'icu'
    if (row.kind === 'core' || (row.key && isSetupFormat(row.key))) return 'go'
    return 'plain'
}

const PLACEHOLDER_NOTE = /^placeholder (\{\w+\}): (.*)$/
const TAG_NUMBER = /^<\/?(\d+)>$/

function Note({ note }: { note: string }) {
    const m = PLACEHOLDER_NOTE.exec(note)
    if (m) {
        return (
            <li>
                <span className="font-mono text-plum">{m[1]}</span> is{' '}
                <code className="font-mono text-[12px]">{m[2]}</code> in the code
            </li>
        )
    }
    return <li>{note}</li>
}

interface Props {
    row: Row
    tag: string
    values: string[]
    shipped: string[] | undefined
    edited: boolean
    status: Status
    problems: Problem[] | undefined
    reference: { tag: string; values: string[] } | undefined
    /** The numbers that pick each form of a count in core.po, such as "2, 3, 4, 22…". */
    forms: string[]
    pageTitles: Map<string, string>
    onChange: (id: string, values: string[]) => void
    onMove: (id: string, where: Move) => void
}

/** One text: the English on the left, the translation on the right. */
export const RowView = memo(function RowView({
    row,
    tag,
    values,
    shipped,
    edited,
    status,
    problems,
    reference,
    forms,
    pageTitles,
    onChange,
    onMove,
}: Props) {
    const areas = useRef<(HTMLTextAreaElement | null)[]>([])
    const active = useRef(0)
    const syntax = syntaxOf(row)
    const count = row.kind === 'core' && row.plural ? forms.length : 1
    const empty = values.every((v) => v.trim() === '')

    const set = (i: number, text: string) => {
        const next = Array.from({ length: count }, (_, j) => (j === i ? text : (values[j] ?? '')))
        onChange(row.id, next)
    }

    const pick = (token: string) => {
        const i = active.current
        const el = areas.current[i]
        if (!el) return
        const v = values[i] ?? ''
        const { selectionStart: start, selectionEnd: end } = el
        const tagNumber = TAG_NUMBER.exec(token)?.[1]
        let text = token
        let caret = start + token.length
        if (tagNumber !== undefined) {
            const inner = v.slice(start, end)
            text = `<${tagNumber}>${inner}</${tagNumber}>`
            caret = inner ? start + text.length : start + `<${tagNumber}>`.length
        }
        set(i, v.slice(0, start) + text + v.slice(end))
        requestAnimationFrame(() => {
            el.focus()
            el.setSelectionRange(caret, caret)
        })
    }

    const fromEnglish = () => {
        if (row.kind === 'core' && row.plural) {
            const plural = row.plural
            onChange(
                row.id,
                Array.from({ length: count }, (_, i) => (i === 0 && count > 1 ? row.text : plural))
            )
        } else if (row.kind === 'app') onChange(row.id, [withForms(row.text, tag)])
        else onChange(row.id, [row.text])
        requestAnimationFrame(() => areas.current[0]?.focus())
    }

    const keys = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onMove(row.id, 'todo')
        } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            onMove(row.id, e.key === 'ArrowDown' ? 'next' : 'prev')
        }
    }

    const also = (row.also ?? []).map((id) => pageTitles.get(id)).filter(Boolean)
    // An rclone text's key after its heading, when it says more than "help".
    const keyTail = row.key ? row.key.slice(row.key.indexOf(row.group, 1) + 1) : []
    const where =
        keyTail.length > 1 || (keyTail.length === 1 && keyTail[0] !== 'help')
            ? keyTail.join(' › ')
            : ''
    const notes = row.notes ? [...new Set(row.notes)] : []
    const errors = problems?.filter((p) => p.level === 'error') ?? []
    const warnings = problems?.filter((p) => p.level === 'warning') ?? []

    return (
        <div
            data-row={row.id}
            data-status={status}
            className="group/row relative grid scroll-mt-40 gap-x-6 gap-y-3 py-4 pr-4 pl-5 [content-visibility:auto] [contain-intrinsic-size:auto_140px] focus-within:bg-cobalt-soft/35 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        >
            <span
                className={`absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full ${RAIL[status]}`}
                aria-hidden="true"
            />
            <div className="min-w-0">
                <p
                    lang="en"
                    className="whitespace-pre-wrap text-[15px] text-ink leading-relaxed [overflow-wrap:anywhere]"
                >
                    <Highlight text={row.text} syntax={syntax} onPick={pick} />
                </p>
                {row.plural && (
                    <p
                        lang="en"
                        className="mt-1 whitespace-pre-wrap text-[15px] text-graphite leading-relaxed"
                    >
                        <span className="mr-1.5 text-[12px] text-faint">More than one:</span>
                        <Highlight text={row.plural} syntax={syntax} onPick={pick} />
                    </p>
                )}
                {(row.ctx || notes.length > 0 || also.length > 0 || where) && (
                    <ul className="mt-2 space-y-0.5 text-[12.5px] text-graphite leading-snug">
                        {row.ctx && (
                            <li>
                                <span className="text-faint">Context:</span> {row.ctx}
                            </li>
                        )}
                        {notes.map((n) => (
                            <Note key={n} note={n} />
                        ))}
                        {also.length > 0 && (
                            <li className="text-faint">Also on: {also.join(', ')}</li>
                        )}
                        {where && <li className="font-mono text-[11.5px] text-faint">{where}</li>}
                    </ul>
                )}
                {reference?.values.some((v) => v) && (
                    <p
                        lang={reference.tag}
                        className="mt-2.5 whitespace-pre-wrap border-line border-l-2 pl-2.5 text-[13.5px] text-graphite leading-relaxed"
                    >
                        <span className="mr-1.5 font-mono text-[10.5px] text-faint uppercase tracking-wider">
                            {reference.tag}
                        </span>
                        {reference.values.filter(Boolean).join('  ·  ')}
                    </p>
                )}
            </div>

            <div className="min-w-0">
                <div className="space-y-2">
                    {Array.from({ length: count }, (_, i) => (
                        <div key={forms[i] ?? i}>
                            {count > 1 && (
                                <span className="mb-1 block font-mono text-[11.5px] text-faint">
                                    For {forms[i] || 'other numbers'}
                                </span>
                            )}
                            <div className="relative">
                                <textarea
                                    ref={(el) => {
                                        areas.current[i] = el
                                    }}
                                    lang={tag}
                                    dir="auto"
                                    spellCheck={true}
                                    rows={Math.min(8, Math.ceil(row.text.length / 60) || 1)}
                                    value={values[i] ?? ''}
                                    placeholder={i === 0 ? 'Your translation' : ''}
                                    aria-label={`Translation of: ${row.text.slice(0, 80)}${count > 1 ? `, for ${forms[i] || 'other numbers'}` : ''}`}
                                    onFocus={() => {
                                        active.current = i
                                    }}
                                    onChange={(e) => set(i, e.target.value)}
                                    onKeyDown={keys}
                                    className="block min-h-11 w-full resize-y rounded-lg bg-paper px-3 py-2 text-[15px] text-ink leading-relaxed shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-[box-shadow] [field-sizing:content] placeholder:text-faint focus:bg-panel focus:shadow-[inset_0_0_0_1.5px_var(--cobalt),0_0_0_3px_var(--cobalt-soft)]"
                                />
                                {i === 0 && empty && (
                                    <button
                                        type="button"
                                        onClick={fromEnglish}
                                        className={`${buttons.ghost} absolute top-1.5 right-1.5 bg-panel opacity-0 shadow-[0_0_0_1px_var(--line)] transition-[opacity,scale] group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100`}
                                    >
                                        <Icon name="copy" className="size-3.5" />
                                        Start from the English
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
                {(errors.length > 0 || warnings.length > 0) && (
                    <ul className="mt-2 space-y-1 text-[13px] leading-snug">
                        {[...errors, ...warnings].map((p) => (
                            <li
                                key={p.message}
                                className={`flex gap-1.5 ${p.level === 'error' ? 'text-error' : 'text-warn'}`}
                            >
                                <Icon name="warning" className="mt-px size-3.5" />
                                <span>{p.message}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {edited && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {shipped && (
                            <button
                                type="button"
                                className={buttons.ghost}
                                onClick={() => onChange(row.id, shipped)}
                            >
                                <Icon name="undo" className="size-3.5" />
                                Undo my change
                            </button>
                        )}
                        <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-cobalt">
                            <span className="size-1.5 rounded-full bg-cobalt" aria-hidden="true" />
                            Changed
                        </span>
                    </div>
                )}
            </div>
        </div>
    )
})
