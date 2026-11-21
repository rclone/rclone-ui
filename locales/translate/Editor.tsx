import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { checkRow, type Problem } from './checks.ts'
import { DownloadDialog } from './DownloadDialog.tsx'
import { LanguageDialog } from './LanguageDialog.tsx'
import { gettextExamples, gettextRule } from './plurals.ts'
import { type Move, RowView, type Status } from './RowView.tsx'
import {
    fetchData,
    go,
    loadPrefs,
    loadWork,
    removeWork,
    savePrefs,
    saveWork,
    type Work,
} from './store.ts'
import type { Catalog, Page, Shipped } from './types.ts'
import { buttons, Dialog, Icon, nativeName, number, percent } from './ui.tsx'

type Filter = 'all' | 'todo' | 'problems' | 'changed'

const FILTERS: [Filter, string][] = [
    ['all', 'All'],
    ['todo', 'To do'],
    ['problems', 'Problems'],
    ['changed', 'Changed'],
]

const NOTHING: string[] = []
const NOT_SHIPPED: Shipped = { pluralForms: '', values: {} }
const SEARCH_LIMIT = 300

export interface Counts {
    total: number
    done: number
    errors: number
}

function same(a: string[] | undefined, b: string[] | undefined) {
    return (a ?? []).join('\u0000') === (b ?? []).join('\u0000')
}

export function newWork(tag: string, name?: string, pluralForms?: string): Work {
    return {
        tag,
        name: name ?? nativeName(tag),
        pluralForms: pluralForms || gettextRule(tag),
        edits: {},
        updated: Date.now(),
    }
}

/** Merges texts from a file into the work. A text that is what the language ships isn't kept. */
export function mergeInto(work: Work, values: Record<string, string[]>, shipped: Shipped): Work {
    const edits = { ...work.edits }
    for (const [id, v] of Object.entries(values)) {
        if (same(v, shipped.values[id])) delete edits[id]
        else edits[id] = v
    }
    return { ...work, edits, updated: Date.now() }
}

export function Editor({
    catalog,
    tag,
    pageId,
}: {
    catalog: Catalog
    tag: string
    pageId: string
}) {
    const language = catalog.languages.find((l) => l.tag === tag)
    const [shipped, setShipped] = useState<Shipped | null>(language ? null : NOT_SHIPPED)
    const [loadFailed, setLoadFailed] = useState(false)
    useEffect(() => {
        if (!language) return
        let live = true
        fetchData<Shipped>(tag).then(
            (s) => live && setShipped(s),
            () => live && setLoadFailed(true)
        )
        return () => {
            live = false
        }
    }, [tag, language])

    const [work, setWork] = useState<Work>(
        () => loadWork(tag) ?? newWork(tag, language?.name, language?.pluralForms)
    )
    const [saveState, setSaveState] = useState<'idle' | 'saved' | 'failed'>('idle')
    useEffect(() => {
        const timer = setTimeout(() => {
            if (language && Object.keys(work.edits).length === 0) {
                removeWork(tag)
                return
            }
            setSaveState(saveWork(work) ? 'saved' : 'failed')
        }, 400)
        return () => clearTimeout(timer)
    }, [work, tag, language])

    const shippedValues = shipped?.values ?? NOT_SHIPPED.values
    const valuesOf = useCallback(
        (id: string) => work.edits[id] ?? shippedValues[id] ?? NOTHING,
        [work.edits, shippedValues]
    )

    const checked = useRef(new Map<string, Problem[]>())
    const state = useMemo(() => {
        const status = new Map<string, Status>()
        const problems = new Map<string, Problem[]>()
        for (const row of catalog.rows) {
            const v = valuesOf(row.id)
            if (v.every((s) => s.trim() === '')) {
                status.set(row.id, 'todo')
                continue
            }
            const key = `${row.id}\u0000${v.join('\u0001')}`
            let p = checked.current.get(key)
            if (!p) {
                p = checkRow(row, v, tag)
                checked.current.set(key, p)
            }
            problems.set(row.id, p)
            status.set(
                row.id,
                p.some((x) => x.level === 'error') ? 'error' : p.length > 0 ? 'warn' : 'done'
            )
        }
        return { status, problems }
    }, [catalog, valuesOf, tag])

    const counts = useMemo(() => {
        const byPage = new Map<string, Counts>()
        const app: Counts = { total: 0, done: 0, errors: 0 }
        const rclone: Counts = { total: 0, done: 0, errors: 0 }
        for (const p of catalog.pages) {
            const c: Counts = { total: p.rows.length, done: 0, errors: 0 }
            for (const i of p.rows) {
                const s = state.status.get(catalog.rows[i].id)
                if (s !== 'todo') c.done++
                if (s === 'error') c.errors++
            }
            byPage.set(p.id, c)
            const sum = p.part === 'app' ? app : rclone
            sum.total += c.total
            sum.done += c.done
            sum.errors += c.errors
        }
        return { byPage, app, rclone }
    }, [catalog, state])

    const page = catalog.pages.find((p) => p.id === pageId) ?? catalog.pages[0]
    const pageTitles = useMemo(() => new Map(catalog.pages.map((p) => [p.id, p.title])), [catalog])
    const forms = useMemo(() => gettextExamples(work.pluralForms), [work.pluralForms])

    const [prefs, setPrefs] = useState(loadPrefs)
    const reference = catalog.languages.some((l) => l.tag === prefs.reference && l.tag !== tag)
        ? prefs.reference
        : ''
    const [referenceValues, setReferenceValues] = useState<Shipped['values']>({})
    useEffect(() => {
        setReferenceValues({})
        if (!reference) return
        let live = true
        fetchData<Shipped>(reference)
            .then((s) => live && setReferenceValues(s.values))
            .catch(() => undefined)
        return () => {
            live = false
        }
    }, [reference])

    const [query, setQuery] = useState('')
    const q = useDeferredValue(query.trim().toLowerCase())
    const [filter, setFilter] = useState<Filter>('all')

    // The list is worked out when the page, the filter or the search changes, and not as the
    // translator types, so that a text doesn't leave the To do list while it is being written.
    const latest = useRef({ state, work, valuesOf })
    latest.current = { state, work, valuesOf }
    // biome-ignore lint/correctness/useExhaustiveDependencies: the texts are filtered again once the language's texts arrive
    const sections = useMemo(() => {
        const { state: s, work: w, valuesOf: value } = latest.current
        const keep = (i: number) => {
            const row = catalog.rows[i]
            const status = s.status.get(row.id)
            if (filter === 'todo' && status !== 'todo') return false
            if (filter === 'problems' && status !== 'error' && status !== 'warn') return false
            if (filter === 'changed' && !w.edits[row.id]) return false
            if (!q) return true
            const fields = [row.text, row.plural, row.ctx, ...(row.notes ?? []), ...value(row.id)]
            if (row.key) fields.push(row.key.join(' '))
            return fields.some((f) => f?.toLowerCase().includes(q))
        }
        if (!q) return [{ page, rows: page.rows.filter(keep) }]
        let left = SEARCH_LIMIT
        const out: { page: Page; rows: number[] }[] = []
        for (const p of catalog.pages) {
            if (left <= 0) break
            const rows = p.rows.filter(keep).slice(0, left)
            left -= rows.length
            if (rows.length > 0) out.push({ page: p, rows })
        }
        return out
    }, [catalog, page, filter, q, shipped])
    const shown = sections.reduce((n, s) => n + s.rows.length, 0)

    const setValue = useCallback(
        (id: string, values: string[]) => {
            setWork((w) => {
                const edits = { ...w.edits }
                const base = shippedValues[id]
                const blank = values.every((v) => v === '')
                if (same(values, base) || (blank && !base)) delete edits[id]
                else edits[id] = values
                return { ...w, edits, updated: Date.now() }
            })
        },
        [shippedValues]
    )

    const list = useRef<HTMLDivElement>(null)
    const focusNext = useRef(false)
    const reducedMotion = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])
    const focusRow = useCallback(
        (node: HTMLElement | undefined) => {
            if (!node) return
            node.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' })
            node.querySelector('textarea')?.focus({ preventScroll: true })
        },
        [reducedMotion]
    )

    const nextPageToDo = useCallback(() => {
        const start = catalog.pages.indexOf(page)
        const order = [...catalog.pages.slice(start + 1), ...catalog.pages.slice(0, start)]
        return order.find((p) => {
            const c = counts.byPage.get(p.id)
            return c && c.done < c.total && p.part === page.part
        })
    }, [catalog, page, counts])

    const move = useCallback(
        (id: string, where: Move) => {
            const nodes = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])]
            const i = nodes.findIndex((n) => n.dataset.row === id)
            if (where === 'prev') return focusRow(nodes[i - 1])
            if (where === 'next') return focusRow(nodes[i + 1])
            const todo = nodes
                .slice(i + 1)
                .find((n) => n.dataset.status === 'todo' || n.dataset.status === 'error')
            if (todo) return focusRow(todo)
            const next = nextPageToDo()
            if (next && !q) {
                focusNext.current = true
                go(tag, next.id)
            }
        },
        [focusRow, nextPageToDo, q, tag]
    )

    // biome-ignore lint/correctness/useExhaustiveDependencies: it runs when a new page shows
    useEffect(() => {
        if (!focusNext.current) return
        focusNext.current = false
        const first = list.current?.querySelector<HTMLElement>(
            '[data-status="todo"], [data-status="error"]'
        )
        focusRow(first ?? undefined)
    }, [page.id, focusRow])

    // biome-ignore lint/correctness/useExhaustiveDependencies: a new page starts at the top
    useEffect(() => {
        window.scrollTo({ top: 0 })
    }, [page.id])

    // The page list sits under the header, whose height changes as it wraps.
    const measureHeader = useCallback((el: HTMLElement | null) => {
        if (!el) return
        const observer = new ResizeObserver(() => {
            document.documentElement.style.setProperty('--header', `${el.offsetHeight}px`)
        })
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    const [dialog, setDialog] = useState<'' | 'download' | 'language' | 'terms'>('')
    const pageCount = counts.byPage.get(page.id) ?? { total: 0, done: 0, errors: 0 }
    const appPages = catalog.pages.filter((p) => p.part === 'app')
    const rclonePages = catalog.pages.filter((p) => p.part === 'rclone')
    const nextPage = catalog.pages[catalog.pages.indexOf(page) + 1]

    if (loadFailed) {
        return (
            <Centered>
                <p>
                    The texts for {work.name} could not be loaded. Check your connection and reload
                    the page.
                </p>
            </Centered>
        )
    }
    if (!shipped) return <Centered>Loading {work.name}…</Centered>

    const languageName = work.name || nativeName(tag)

    return (
        <div className="min-h-dvh">
            <header
                ref={measureHeader}
                className="sticky top-0 z-20 bg-panel/90 shadow-[0_1px_0_var(--line)] backdrop-blur-md"
            >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 md:px-6">
                    <a
                        href="#/"
                        className="flex items-center gap-2 rounded-md font-semibold text-[15px] tracking-tight outline-offset-2 focus-visible:outline-2 focus-visible:outline-cobalt"
                    >
                        <Icon name="back" className="size-4 text-faint" />
                        Rclone UI <span className="font-normal text-graphite">Translate</span>
                    </a>
                    <button
                        type="button"
                        className={`${buttons.secondary} py-1.5`}
                        onClick={() => setDialog('language')}
                        title="Language details"
                    >
                        <span lang={tag}>{languageName}</span>
                        <span className="font-mono text-[11px] text-faint">{tag}</span>
                    </button>
                    <p className="hidden font-mono text-[12.5px] text-graphite tabular-nums lg:block">
                        Translated: {number(counts.app.done)} / {number(counts.app.total)},{' '}
                        <span className="text-ink">
                            {percent(counts.app.done, counts.app.total)}%
                        </span>
                        {counts.app.errors > 0 && (
                            <span className="text-error">
                                , problems: {number(counts.app.errors)}
                            </span>
                        )}
                    </p>
                    <div className="ml-auto flex items-center gap-2">
                        <span
                            className={`hidden text-[12px] sm:inline ${saveState === 'failed' ? 'text-error' : 'text-faint'}`}
                            role="status"
                        >
                            {saveState === 'failed'
                                ? 'Not saved: this browser is out of room. Download your file now.'
                                : saveState === 'saved'
                                  ? 'Saved in this browser'
                                  : ''}
                        </span>
                        <label className="relative">
                            <span className="sr-only">Search all texts</span>
                            <Icon
                                name="search"
                                className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-faint"
                            />
                            <input
                                type="search"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search all texts"
                                className="w-44 rounded-lg bg-paper py-1.5 pr-2.5 pl-8 text-sm shadow-[inset_0_0_0_1px_var(--line)] outline-none transition-[width,box-shadow] placeholder:text-faint focus:w-64 focus:shadow-[inset_0_0_0_1.5px_var(--cobalt)]"
                            />
                        </label>
                        <button
                            type="button"
                            className={buttons.primary}
                            onClick={() => setDialog('download')}
                        >
                            <Icon name="download" />
                            Download
                        </button>
                    </div>
                </div>
                <Strip pages={appPages} counts={counts.byPage} current={page.id} tag={tag} />
            </header>

            <div className="md:grid md:grid-cols-[15.5rem_minmax(0,1fr)]">
                <nav
                    aria-label="Pages"
                    className="sticky top-[var(--header)] hidden h-[calc(100dvh-var(--header))] overflow-y-auto border-line border-r px-3 py-4 md:block"
                >
                    <NavGroup
                        title="The app"
                        pages={appPages}
                        counts={counts.byPage}
                        current={page.id}
                        tag={tag}
                    />
                    <details className="mt-5" open={page.part === 'rclone'}>
                        <summary className="cursor-pointer select-none rounded-md px-2 py-1 text-[11.5px] text-faint uppercase tracking-[0.08em] hover:text-graphite">
                            rclone&rsquo;s help texts
                            <span className="ml-1.5 font-mono normal-case tracking-normal">
                                {percent(counts.rclone.done, counts.rclone.total)}%
                            </span>
                        </summary>
                        <p className="mt-1 mb-2 px-2 text-[12px] text-faint leading-snug">
                            Optional. The app shows these in English until they are translated.
                        </p>
                        <NavGroup
                            pages={rclonePages}
                            counts={counts.byPage}
                            current={page.id}
                            tag={tag}
                        />
                    </details>
                </nav>

                <main className="min-w-0 px-3 pt-5 pb-24 md:px-8">
                    <label className="mb-4 block md:hidden">
                        <span className="sr-only">Page</span>
                        <select
                            value={page.id}
                            onChange={(e) => go(tag, e.target.value)}
                            className="w-full rounded-lg bg-panel px-3 py-2 text-sm shadow-[inset_0_0_0_1px_var(--line)]"
                        >
                            {catalog.pages.map((p) => {
                                const c = counts.byPage.get(p.id)
                                return (
                                    <option key={p.id} value={p.id}>
                                        {p.title} ({c ? c.total - c.done : 0} to do)
                                    </option>
                                )
                            })}
                        </select>
                    </label>

                    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                        <div className="min-w-0">
                            {q ? (
                                <h1 className="font-semibold text-2xl tracking-tight">
                                    {shown === SEARCH_LIMIT ? `The first ${shown}` : number(shown)}{' '}
                                    texts with &ldquo;{query.trim()}&rdquo;
                                </h1>
                            ) : (
                                <>
                                    <h1 className="font-semibold text-2xl tracking-tight">
                                        {page.title}
                                    </h1>
                                    <p
                                        className="mt-1 line-clamp-2 max-w-4xl font-mono text-[12.5px] text-graphite tabular-nums"
                                        title={page.about}
                                    >
                                        {number(pageCount.done)} / {number(pageCount.total)}{' '}
                                        translated
                                        {page.about && (
                                            <span className="font-sans text-faint">
                                                {' '}
                                                · {page.about}
                                            </span>
                                        )}
                                    </p>
                                </>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <fieldset className="flex rounded-lg bg-paper p-0.5 shadow-[inset_0_0_0_1px_var(--line)]">
                                <legend className="sr-only">Show</legend>
                                {FILTERS.map(([value, label]) => (
                                    <label
                                        key={value}
                                        className="cursor-pointer rounded-md px-2.5 py-1 text-[13px] text-graphite transition-[background-color,color] has-checked:bg-panel has-checked:text-ink has-checked:shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.06)] has-focus-visible:outline-2 has-focus-visible:outline-cobalt"
                                    >
                                        <input
                                            type="radio"
                                            name="filter"
                                            value={value}
                                            checked={filter === value}
                                            onChange={() => setFilter(value)}
                                            className="sr-only"
                                        />
                                        {label}
                                    </label>
                                ))}
                            </fieldset>
                            {catalog.languages.some((l) => l.tag !== tag) && (
                                <label className="flex items-center gap-1.5 text-[13px] text-graphite">
                                    Also show
                                    <select
                                        value={reference}
                                        onChange={(e) => {
                                            const next = { ...prefs, reference: e.target.value }
                                            setPrefs(next)
                                            savePrefs(next)
                                        }}
                                        className="rounded-lg bg-panel px-2 py-1 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--line)]"
                                    >
                                        <option value="">No other language</option>
                                        {catalog.languages
                                            .filter((l) => l.tag !== tag)
                                            .map((l) => (
                                                <option key={l.tag} value={l.tag}>
                                                    {l.name}
                                                </option>
                                            ))}
                                    </select>
                                </label>
                            )}
                            {shipped.terms && (
                                <button
                                    type="button"
                                    className={`${buttons.secondary} py-1.5`}
                                    onClick={() => setDialog('terms')}
                                >
                                    <Icon name="book" />
                                    Terms
                                </button>
                            )}
                        </div>
                    </div>

                    <div ref={list}>
                        {sections.map((s) => (
                            <Section key={s.page.id} title={q ? s.page.title : undefined}>
                                {groups(catalog, s.rows).map((g) => (
                                    <div key={`${g.name}:${g.rows[0]}`} className="mb-6">
                                        <h2 className="mb-1.5 px-1 font-mono text-[11.5px] text-faint">
                                            {g.name}
                                        </h2>
                                        <div className="divide-y divide-line overflow-hidden rounded-xl bg-panel shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.04)]">
                                            {g.rows.map((i) => {
                                                const row = catalog.rows[i]
                                                const ref = reference
                                                    ? referenceValues[row.id]
                                                    : undefined
                                                return (
                                                    <RowView
                                                        key={row.id}
                                                        row={row}
                                                        tag={tag}
                                                        values={valuesOf(row.id)}
                                                        shipped={shipped.values[row.id]}
                                                        edited={row.id in work.edits}
                                                        status={state.status.get(row.id) ?? 'todo'}
                                                        problems={state.problems.get(row.id)}
                                                        reference={
                                                            ref
                                                                ? { tag: reference, values: ref }
                                                                : undefined
                                                        }
                                                        forms={forms}
                                                        pageTitles={pageTitles}
                                                        onChange={setValue}
                                                        onMove={move}
                                                    />
                                                )
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </Section>
                        ))}
                        {shown === 0 && (
                            <div className="rounded-xl bg-panel px-6 py-12 text-center shadow-[0_0_0_1px_var(--line)]">
                                <p className="text-graphite">
                                    {q
                                        ? 'No text has those words.'
                                        : filter === 'todo'
                                          ? 'Nothing left to translate on this page.'
                                          : filter === 'problems'
                                            ? 'No problems on this page.'
                                            : 'You haven’t changed anything on this page.'}
                                </p>
                            </div>
                        )}
                    </div>

                    {!q && nextPage && (
                        <div className="mt-8 flex justify-end">
                            <button
                                type="button"
                                className={buttons.secondary}
                                onClick={() => go(tag, nextPage.id)}
                            >
                                Next: {nextPage.title}
                                <Icon name="next" />
                            </button>
                        </div>
                    )}
                    <p className="mt-10 text-center text-[12px] text-faint">
                        <kbd className="font-mono">⌘ Enter</kbd> or{' '}
                        <kbd className="font-mono">Ctrl Enter</kbd> goes to the next text to do.{' '}
                        <kbd className="font-mono">Alt ↑ ↓</kbd> moves between texts.
                    </p>
                </main>
            </div>

            <DownloadDialog
                open={dialog === 'download'}
                onClose={() => setDialog('')}
                catalog={catalog}
                work={work}
                shipped={shipped}
                isNew={!language}
                counts={counts}
                onShowProblems={() => {
                    setDialog('')
                    setFilter('problems')
                    const first = catalog.pages.find(
                        (p) => (counts.byPage.get(p.id)?.errors ?? 0) > 0
                    )
                    if (first) go(tag, first.id)
                }}
            />
            <LanguageDialog
                open={dialog === 'language'}
                onClose={() => setDialog('')}
                catalog={catalog}
                work={work}
                shipped={shipped}
                isNew={!language}
                onChange={setWork}
            />
            <Dialog
                open={dialog === 'terms'}
                onClose={() => setDialog('')}
                title={`${languageName}: terms and style`}
                wide={true}
            >
                <pre
                    lang={tag}
                    className="whitespace-pre-wrap font-sans text-[14px] text-ink leading-relaxed"
                >
                    {shipped.terms}
                </pre>
            </Dialog>
        </div>
    )
}

function groups(catalog: Catalog, rows: number[]) {
    const out: { name: string; rows: number[] }[] = []
    for (const i of rows) {
        const name = catalog.rows[i].group || 'Other'
        const last = out[out.length - 1]
        if (last?.name === name) last.rows.push(i)
        else out.push({ name, rows: [i] })
    }
    return out
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
    if (!title) return <>{children}</>
    return (
        <section className="mb-8">
            <h2 className="mb-3 font-semibold text-lg tracking-tight">{title}</h2>
            {children}
        </section>
    )
}

export function Centered({ children }: { children: React.ReactNode }) {
    return (
        <div className="grid min-h-dvh place-items-center p-8 text-center text-graphite">
            {children}
        </div>
    )
}

function NavGroup({
    title,
    pages,
    counts,
    current,
    tag,
}: {
    title?: string
    pages: Page[]
    counts: Map<string, Counts>
    current: string
    tag: string
}) {
    return (
        <div>
            {title && (
                <h2 className="mb-1 px-2 text-[11.5px] text-faint uppercase tracking-[0.08em]">
                    {title}
                </h2>
            )}
            <ul>
                {pages.map((p) => {
                    const c = counts.get(p.id) ?? { total: 0, done: 0, errors: 0 }
                    const left = c.total - c.done
                    return (
                        <li key={p.id}>
                            <a
                                href={`#/${tag}/${p.id}`}
                                aria-current={p.id === current ? 'page' : undefined}
                                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13.5px] text-graphite leading-snug transition-[background-color,color] hover:bg-line/50 hover:text-ink aria-[current=page]:bg-cobalt-soft aria-[current=page]:font-medium aria-[current=page]:text-cobalt"
                            >
                                <span className="min-w-0 truncate">{p.title}</span>
                                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] tabular-nums">
                                    {c.errors > 0 && (
                                        <span
                                            className="size-1.5 rounded-full bg-error"
                                            title={`${c.errors} with problems`}
                                        />
                                    )}
                                    {left === 0 ? (
                                        <Icon name="check" className="size-3.5 text-done" />
                                    ) : (
                                        <span className="text-faint" title={`${left} to do`}>
                                            {number(left)}
                                        </span>
                                    )}
                                </span>
                            </a>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

/**
 * The whole app at a glance: a segment for each page, as wide as the page has texts, filled as far
 * as it is translated.
 */
function Strip({
    pages,
    counts,
    current,
    tag,
}: {
    pages: Page[]
    counts: Map<string, Counts>
    current: string
    tag: string
}) {
    return (
        <div className="flex h-2.5 items-stretch gap-[2px] px-4 pb-1 md:px-6" aria-hidden="true">
            {pages.map((p) => {
                const c = counts.get(p.id) ?? { total: 1, done: 0, errors: 0 }
                return (
                    <a
                        key={p.id}
                        href={`#/${tag}/${p.id}`}
                        tabIndex={-1}
                        title={`${p.title}: ${c.done} of ${c.total}`}
                        style={{ flexGrow: c.total }}
                        className={`group relative basis-0 overflow-hidden rounded-[2px] transition-[transform] hover:scale-y-150 ${p.id === current ? 'bg-cobalt/25' : 'bg-line'}`}
                    >
                        <span
                            className={`absolute inset-y-0 left-0 ${c.errors ? 'bg-error' : p.id === current ? 'bg-cobalt' : 'bg-done'}`}
                            style={{ width: `${(c.done / c.total) * 100}%` }}
                        />
                    </a>
                )
            })}
        </div>
    )
}
