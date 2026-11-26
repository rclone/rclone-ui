import { cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { AnimatePresence, motion } from 'framer-motion'
import {
    type CSSProperties,
    type PointerEvent,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react'
import {
    type LauncherFrame,
    type LauncherInit,
    LauncherStatus,
    launcherPage,
} from '../../../lib/shell'
import { keyAction, rowAt, wheelRows } from './keys'

const DRAG = { '--wails-draggable': 'drag' } as CSSProperties
const NO_DRAG = { '--wails-draggable': 'no-drag' } as CSSProperties

const EASE_OUT = [0.33, 1, 0.68, 1] as const

function Glyph({ svg, className, size }: { svg?: string; className?: string; size?: number }) {
    const style = size ? { width: size, height: size } : undefined
    if (!svg) return <span className={className} style={style} />
    return (
        <span
            className={cn('[&>svg]:size-full', className)}
            style={style}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: the markup comes from the app, not the user
            dangerouslySetInnerHTML={{ __html: svg }}
        />
    )
}

function select(box: HTMLInputElement, text: string, all: boolean) {
    box.value = text
    if (all) box.select()
    else box.setSelectionRange(text.length, text.length)
}

function Title({ text, bold }: { text: string; bold: number[] | null }) {
    if (!bold?.length) return <>{text}</>
    const on = new Set(bold)
    return (
        <>
            {Array.from(text).map((ch, i) => (
                <span key={i} className={on.has(i) ? 'font-semibold' : undefined}>
                    {ch}
                </span>
            ))}
        </>
    )
}

function onWindowFocus(callback: () => void): () => void {
    window.addEventListener('focus', callback)
    return () => window.removeEventListener('focus', callback)
}

export default function Launcher() {
    const [init, setInit] = useState<LauncherInit | null>(null)
    const [frame, setFrame] = useState<LauncherFrame | null>(null)
    const [text, setText] = useState('')
    const input = useRef<HTMLInputElement>(null)
    const [first, setFirst] = useState<{ selectAll: boolean } | null>(null)
    const lastPointer = useRef<{ x: number; y: number } | null>(null)
    const carried = useRef(0)
    const edits = useRef(0)
    const dragging = useRef(false)
    const filesOver = useRef(false)

    useEffect(() => {
        let alive = true
        launcherPage
            .ready()
            .then((i) => {
                if (!alive) return
                setInit(i)
                setFrame(i.frame)
                edits.current = i.query.seq
                setText(i.query.text)
                setFirst({ selectAll: i.query.selectAll })
                if (i.visible) input.current?.focus()
            })
            .catch((error: unknown) => console.error('[launcher page] ready', error))
        const offs = [
            launcherPage.onRender((f) => setFrame(f)),
            launcherPage.onQuery((q) => {
                if (q.seq !== edits.current) return
                const box = input.current
                if (box) select(box, q.text, q.selectAll)
                setText(q.text)
            }),
            launcherPage.onShown(() => {
                lastPointer.current = null
                carried.current = 0
                input.current?.focus()
            }),
            onWindowFocus(() => input.current?.focus()),
            launcherPage.onHidden(() => {
                dragging.current = false
                filesOver.current = false
                input.current?.select()
            }),
        ]
        return () => {
            alive = false
            for (const off of offs) off()
        }
    }, [])

    useLayoutEffect(() => {
        const box = input.current
        if (first && box) select(box, box.value, first.selectAll)
    }, [first])

    const g = init?.geometry
    const layout = frame?.layout
    const rowTops = layout?.rowTops ?? []
    const listBottom = (layout?.rowsTop ?? 0) + (layout?.listH ?? 0)

    const onPointerMove = useCallback(
        (e: PointerEvent) => {
            if (!g) return
            if (dragging.current) {
                launcherPage.dragMove(e.clientX, e.clientY)
                return
            }
            const last = lastPointer.current
            lastPointer.current = { x: e.clientX, y: e.clientY }
            if (!last || (last.x === e.clientX && last.y === e.clientY)) return
            const row = rowAt(e.clientY, rowTops, g.rowH, listBottom)
            if (row >= 0) launcherPage.hover(row)
        },
        [g, rowTops, listBottom]
    )

    const onPointerDown = useCallback(
        (e: PointerEvent) => {
            if (e.button !== 0) return
            launcherPage.pressed(true)
            // Wails moves any other window (DRAG), and a layer surface is moved here, because
            // compositors don't move those.
            const target = e.target as HTMLElement
            if (init?.mode === 'layer-shell' && !target.closest('[data-launcher-control]')) {
                dragging.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                launcherPage.dragStart(e.clientX, e.clientY)
            }
        },
        [init?.mode]
    )

    const onPointerUp = useCallback((e: PointerEvent) => {
        if (e.button !== 0) return
        launcherPage.pressed(false)
        if (dragging.current) {
            dragging.current = false
            launcherPage.dragEnd()
        }
    }, [])

    if (!g || !layout || !frame) return null
    const s = frame.snapshot
    const rows = s.rows ?? []
    const line = frame.line
    const lineKey = `${line.status.kind}:${line.status.text}:${line.hints}`
    const swapSeconds = g.swapMs / 1000

    return (
        <div
            data-file-drop-target={true}
            className="relative overflow-hidden select-none bg-content1 text-foreground inset-ring inset-ring-default-200 dark:inset-ring-default-100"
            style={{
                width: g.width,
                height: layout.height,
                ...(init.mode === 'layer-shell' ? {} : DRAG),
            }}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onMouseDown={(e) => {
                if (e.target !== input.current) e.preventDefault()
            }}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={(e) => {
                const r = wheelRows(carried.current, e.deltaY, e.deltaMode, g.rowH)
                carried.current = r.carried
                if (r.rows !== 0) launcherPage.scroll(r.rows)
            }}
            onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return
                e.preventDefault()
                if (!filesOver.current) {
                    filesOver.current = true
                    launcherPage.dragOver(true)
                }
            }}
            onDragLeave={(e) => {
                if (e.relatedTarget || !filesOver.current) return
                filesOver.current = false
                launcherPage.dragOver(false)
            }}
            onDrop={() => {
                if (!filesOver.current) return
                filesOver.current = false
                launcherPage.dragOver(false)
            }}
        >
            <input
                ref={input}
                data-launcher-control={true}
                aria-label={t({ message: 'Search', comment: "The launcher's search field." })}
                value={text}
                placeholder={s.placeholder}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                className="absolute bg-transparent outline-none text-[20px] placeholder:text-default-400"
                style={{ left: 18, top: g.fieldTop, width: g.fieldW, height: 30, ...NO_DRAG }}
                onChange={(e) => {
                    edits.current += 1
                    setText(e.target.value)
                    launcherPage.query(e.target.value, edits.current)
                }}
                onKeyDown={(e) => {
                    const action = keyAction(
                        {
                            key: e.key,
                            ctrl: e.ctrlKey,
                            alt: e.altKey,
                            meta: e.metaKey,
                            shift: e.shiftKey,
                            composing: e.nativeEvent.isComposing || e.keyCode === 229,
                        },
                        init.rowLetters
                    )
                    if (action === null) return
                    e.preventDefault()
                    if (action !== 'swallow') launcherPage.key(action.key, action.char)
                }}
            />

            {s.header && (
                <div
                    className="absolute truncate text-xs text-default-500"
                    style={{
                        left: 18,
                        top: g.queryH,
                        width: g.width - 36,
                        height: g.headerH,
                        lineHeight: '16px',
                    }}
                >
                    {s.header}
                </div>
            )}

            <div
                className="absolute inset-x-0 overflow-hidden"
                style={{ top: layout.rowsTop, height: layout.listH }}
            >
                {rows.map((row, i) => {
                    const top = (rowTops[i] ?? 0) - layout.rowsTop
                    const selected = i === s.selected
                    const dim = selected
                        ? row.danger
                            ? 'text-danger-foreground/80'
                            : 'text-primary-foreground/80'
                        : 'text-default-500'
                    return (
                        <div key={i}>
                            {row.group && (
                                <div
                                    className="absolute truncate text-[11px] font-semibold text-default-500"
                                    style={{
                                        left: 18,
                                        top: top - g.groupH + 5,
                                        width: g.width - 36,
                                        lineHeight: '16px',
                                    }}
                                >
                                    {row.group}
                                </div>
                            )}
                            <div
                                data-launcher-control={true}
                                className={cn(
                                    'absolute flex items-center gap-3 rounded-[10px]',
                                    selected &&
                                        (row.danger
                                            ? 'bg-danger text-danger-foreground'
                                            : 'bg-primary text-primary-foreground')
                                )}
                                style={{
                                    left: g.padding,
                                    top,
                                    width: g.width - 2 * g.padding,
                                    height: g.rowH - 4,
                                    ...NO_DRAG,
                                }}
                                onPointerDown={(e) => {
                                    if (e.button === 0) launcherPage.click(i)
                                }}
                            >
                                <Glyph
                                    svg={init.icons[row.icon]}
                                    className={cn(
                                        'ml-3.5 shrink-0',
                                        !selected && row.danger && 'text-danger'
                                    )}
                                    size={g.iconSize}
                                />
                                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                                    <span className="truncate text-[15px] leading-5">
                                        <Title text={row.title} bold={row.bold} />
                                    </span>
                                    {row.subtitle && (
                                        <span className={cn('truncate text-xs leading-4', dim)}>
                                            {row.subtitle}
                                        </span>
                                    )}
                                </div>
                                {row.tail && (
                                    <span
                                        className={cn(
                                            'max-w-[180px] truncate text-right text-xs',
                                            dim
                                        )}
                                    >
                                        {row.tail}
                                    </span>
                                )}
                                <span
                                    className={cn(
                                        'w-[50px] mr-3.5 shrink-0 text-right text-xs',
                                        dim
                                    )}
                                >
                                    {row.hint}
                                </span>
                            </div>
                        </div>
                    )
                })}
            </div>

            <div
                className="absolute overflow-hidden"
                style={{
                    left: 18,
                    top: layout.footerTop - g.slide,
                    width: g.footerW,
                    height: 18 + 2 * g.slide,
                }}
            >
                <AnimatePresence initial={false} custom={frame.swap}>
                    <motion.div
                        key={lineKey}
                        custom={frame.swap}
                        className={cn(
                            'absolute inset-x-0 flex items-center gap-1.5 text-xs whitespace-nowrap',
                            line.status.kind === LauncherStatus.StatusDone
                                ? 'text-success'
                                : line.status.kind === LauncherStatus.StatusError
                                  ? 'text-danger'
                                  : 'text-default-500'
                        )}
                        style={{ top: g.slide, height: 18 }}
                        title={line.status.text || undefined}
                        initial={frame.swap ? { y: g.slide, opacity: 0 } : false}
                        animate={{ y: 0, opacity: 1 }}
                        exit={
                            frame.swap
                                ? { y: -g.slide, opacity: 0 }
                                : { opacity: 0, transition: { duration: 0 } }
                        }
                        transition={{ duration: swapSeconds, ease: EASE_OUT }}
                    >
                        {line.status.kind === LauncherStatus.StatusLoading && (
                            <span
                                aria-hidden={true}
                                className="shrink-0 border-2 rounded-full animate-spin border-current border-t-transparent"
                                style={{ width: g.spinSize, height: g.spinSize }}
                            />
                        )}
                        <span className="truncate">
                            {line.status.kind === LauncherStatus.StatusNone
                                ? line.hints
                                : line.status.text}
                        </span>
                    </motion.div>
                </AnimatePresence>
            </div>

            <button
                type="button"
                data-launcher-control={true}
                aria-label={t`Stop everything`}
                title={t`Stop everything (Ctrl+.)`}
                className={cn(
                    'absolute flex items-center justify-center rounded-full transition-colors duration-150',
                    s.running
                        ? 'bg-danger/15 text-danger hover:bg-danger/25'
                        : 'bg-default-100 text-default-500 hover:bg-default-200'
                )}
                style={{
                    left: g.stopLeft,
                    top: layout.stopTop,
                    width: g.stopSize,
                    height: g.stopSize,
                    ...NO_DRAG,
                }}
                tabIndex={-1}
                onClick={() => launcherPage.stopAll()}
            >
                <Glyph svg={init.icons.ban} className="size-3.5" />
            </button>
        </div>
    )
}
