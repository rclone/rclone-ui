import { useMemo, useRef, useState } from 'react'
import { mergeInto, newWork } from './Editor.tsx'
import { readFiles } from './files.ts'
import { filesOf } from './LanguageDialog.tsx'
import { GETTEXT_RULES } from './plurals.ts'
import { fetchData, go, loadWork, savedWork, saveWork } from './store.ts'
import type { Catalog, Shipped } from './types.ts'
import { buttons, englishName, Icon, nativeName, number, validTag } from './ui.tsx'

/** The languages offered for a new translation: those with a known counting rule, and some regions. */
const SUGGESTED = [
    ...Object.keys(GETTEXT_RULES).filter((t) => !['pt', 'pt-PT', 'zh'].includes(t)),
    'pt-BR',
    'pt-PT',
    'zh-TW',
    'es-419',
    'fr-CA',
]

const GUIDE = 'https://github.com/rclone/rclone-ui/blob/main/locales/README.md'

export function Start({ catalog }: { catalog: Catalog }) {
    const [query, setQuery] = useState('')
    const [note, setNote] = useState('')
    const input = useRef<HTMLInputElement>(null)
    const drafts = useMemo(() => savedWork(), [])
    const shippedTags = new Set(catalog.languages.map((l) => l.tag))
    const taken = new Set([...shippedTags, ...drafts.map((d) => d.tag), 'en'])

    const options = useMemo(() => {
        const q = query.trim().toLowerCase()
        const list = SUGGESTED.filter((t) => !taken.has(t)).map((tag) => ({
            tag,
            native: nativeName(tag),
            english: englishName(tag),
        }))
        const found = q
            ? list.filter((o) =>
                  [o.tag, o.native, o.english].some((s) => s.toLowerCase().includes(q))
              )
            : list
        found.sort((a, b) => a.english.localeCompare(b.english))
        const typed = validTag(query)
        if (typed && !taken.has(typed) && !found.some((o) => o.tag === typed)) {
            found.unshift({ tag: typed, native: nativeName(typed), english: englishName(typed) })
        }
        return found
    }, [query, taken])

    const start = (tag: string) => {
        if (!loadWork(tag)) saveWork(newWork(tag))
        go(tag)
    }

    const open = async (list: FileList | null) => {
        const opened = readFiles(catalog, await filesOf(list))
        if (!opened.tag) {
            setNote('That file doesn’t say which language it is for.')
            return
        }
        const tag = opened.tag
        const language = catalog.languages.find((l) => l.tag === tag)
        let shipped: Shipped = { pluralForms: '', values: {} }
        if (language) {
            try {
                shipped = await fetchData<Shipped>(tag)
            } catch {
                setNote('The texts for that language could not be loaded. Check your connection.')
                return
            }
        }
        const existing = loadWork(tag)
        const changes = existing ? Object.keys(existing.edits).length : 0
        if (
            changes &&
            !confirm(
                `You have ${number(changes)} changes to ${existing?.name} in this browser. Texts in the file replace them.`
            )
        ) {
            return
        }
        const base = existing ?? newWork(tag, language?.name, language?.pluralForms)
        const work = mergeInto(base, opened.values, shipped)
        if (!language && opened.pluralForms) work.pluralForms = opened.pluralForms
        saveWork(work)
        go(tag)
    }

    const featured = Object.entries(catalog.featured.translations)

    return (
        <div className="mx-auto max-w-6xl px-5 pt-8 pb-24 md:px-10">
            <header className="flex items-center justify-between">
                <p className="font-semibold text-[15px] tracking-tight">
                    Rclone UI <span className="font-normal text-graphite">Translate</span>
                </p>
                <a href={GUIDE} target="_blank" rel="noreferrer" className={buttons.ghost}>
                    Translation guide
                </a>
            </header>

            <section className="mt-16 md:mt-24">
                <h1 className="max-w-3xl text-balance font-semibold text-[clamp(2rem,5vw,3.4rem)] leading-[1.05] tracking-[-0.03em]">
                    Rclone UI (in your language)
                </h1>
                <p className="mt-4 max-w-xl text-lg text-graphite leading-relaxed">
                    Compare, Translate, and Download the result. Open a PR when you&rsquo;re ready!
                </p>

                <div
                    className="mt-12 max-w-3xl"
                    aria-label="One of the app's texts in each language"
                >
                    <Line tag="en" text={catalog.featured.text} muted={true} />
                    {featured.map(([tag, text]) => (
                        <Line key={tag} tag={tag} text={text} />
                    ))}
                    <div className="grid grid-cols-[3.5rem_1fr] items-baseline gap-4 py-2.5">
                        <span className="font-mono text-[11px] text-cobalt uppercase tracking-wider">
                            you
                        </span>
                        <span className="flex items-center text-[clamp(1.1rem,2.4vw,1.6rem)] text-faint">
                            <span
                                className="caret mr-1 inline-block h-[1.1em] w-[2px] bg-cobalt"
                                aria-hidden="true"
                            />
                            Your language
                        </span>
                    </div>
                </div>
            </section>

            <div className="mt-20 grid gap-12 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] md:gap-16">
                <section aria-labelledby="pick">
                    <h2 id="pick" className="font-semibold text-xl tracking-tight">
                        Pick a language
                    </h2>
                    <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl bg-panel shadow-[0_0_0_1px_var(--line),0_1px_2px_rgb(0_0_0/0.04)]">
                        {catalog.languages.map((l) => {
                            const draft = drafts.find((d) => d.tag === l.tag)
                            const changes = draft ? Object.keys(draft.edits).length : 0
                            return (
                                <LanguageRow
                                    key={l.tag}
                                    tag={l.tag}
                                    name={l.name}
                                    detail={
                                        changes
                                            ? `Your ${number(changes)} changes are saved here`
                                            : 'Fix and improve it'
                                    }
                                />
                            )
                        })}
                        {drafts
                            .filter((d) => !shippedTags.has(d.tag))
                            .map((d) => (
                                <LanguageRow
                                    key={d.tag}
                                    tag={d.tag}
                                    name={d.name}
                                    detail={`Your new translation · ${number(Object.keys(d.edits).length)} texts so far`}
                                />
                            ))}
                    </ul>

                    <h3 className="mt-10 font-semibold text-base">Start a new language</h3>
                    <label className="relative mt-3 block">
                        <span className="sr-only">Find your language</span>
                        <Icon
                            name="search"
                            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-faint"
                        />
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Find your language, or type its code (pt-BR)"
                            className="w-full rounded-xl bg-panel py-2.5 pr-3 pl-9 text-[15px] shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1.5px_var(--cobalt),0_0_0_3px_var(--cobalt-soft)]"
                        />
                    </label>
                    <ul className="mt-2 grid max-h-80 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                        {options.map((o) => (
                            <li key={o.tag}>
                                <button
                                    type="button"
                                    onClick={() => start(o.tag)}
                                    className="flex w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left transition-[background-color] hover:bg-panel hover:shadow-[0_0_0_1px_var(--line)] focus-visible:outline-2 focus-visible:outline-cobalt"
                                >
                                    <span className="min-w-0 truncate">
                                        <span lang={o.tag}>{o.native}</span>
                                        {o.native !== o.english && (
                                            <span className="ml-2 text-[13px] text-faint">
                                                {o.english}
                                            </span>
                                        )}
                                    </span>
                                    <span className="whitespace-nowrap font-mono text-[11px] text-faint">
                                        {o.tag}
                                    </span>
                                </button>
                            </li>
                        ))}
                        {options.length === 0 && (
                            <li className="px-3 py-2 text-[14px] text-graphite">
                                No language has that name. Type its code instead, such as pt-BR or
                                sr-Latn.
                            </li>
                        )}
                    </ul>
                </section>

                <aside className="space-y-10">
                    <section>
                        <h2 className="font-semibold text-xl tracking-tight">How it works</h2>
                        <ol className="mt-4 space-y-4 text-[15px] leading-relaxed">
                            <Step n={1} title="Translate">
                                Each page of the app has its own list. Your work is saved in this
                                browser as you type.
                            </Step>
                            <Step n={2} title="Download">
                                One file holds everything. Download it as often as you like.
                            </Step>
                            <Step n={3} title="Send it">
                                Unzip it and open a pull request with its locales folder. You can
                                also upload the zip as it is: what matters is a good translation.
                            </Step>
                        </ol>
                        <button
                            type="button"
                            className={`${buttons.secondary} mt-6`}
                            onClick={() => input.current?.click()}
                        >
                            <Icon name="upload" />
                            Continue from a file
                        </button>
                        <input
                            ref={input}
                            type="file"
                            multiple={true}
                            accept=".zip,.po,.json"
                            className="hidden"
                            onChange={(e) => {
                                open(e.target.files).catch(() =>
                                    setNote('That file could not be read.')
                                )
                                e.target.value = ''
                            }}
                        />
                        {note && (
                            <p className="mt-2 text-[13px] text-error" role="status">
                                {note}
                            </p>
                        )}
                    </section>
                    <section>
                        <h2 className="font-semibold text-xl tracking-tight">
                            How a translation should read
                        </h2>
                        <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] text-graphite leading-relaxed marker:text-faint">
                            <li>
                                As if the app had been made in your language. Translate the meaning,
                                not the words.
                            </li>
                            <li>Short, friendly and direct, like a good modern app.</li>
                            <li>
                                Use the words that macOS and Windows use in your language: Settings,
                                Cancel, Open.
                            </li>
                            <li>
                                Keep names as they are (Rclone UI, rclone, Google Drive), and keep
                                every{' '}
                                <span className="rounded bg-plum-soft px-1 font-mono text-[13px] text-plum">
                                    {'{value}'}
                                </span>{' '}
                                and{' '}
                                <span className="rounded bg-plum-soft px-1 font-mono text-[13px] text-plum">
                                    %s
                                </span>
                                . You may move them.
                            </li>
                        </ul>
                    </section>
                </aside>
            </div>
        </div>
    )
}

function Line({ tag, text, muted = false }: { tag: string; text: string; muted?: boolean }) {
    return (
        <div className="grid grid-cols-[3.5rem_1fr] items-baseline gap-4 border-line border-b py-2.5">
            <span className="font-mono text-[11px] text-faint uppercase tracking-wider">{tag}</span>
            <span
                lang={tag}
                className={`text-[clamp(1.1rem,2.4vw,1.6rem)] leading-snug ${muted ? 'text-graphite' : 'text-ink'}`}
            >
                {text}
            </span>
        </div>
    )
}

function LanguageRow({ tag, name, detail }: { tag: string; name: string; detail: string }) {
    return (
        <li>
            <a
                href={`#/${tag}`}
                className="group flex items-center gap-4 px-4 py-3.5 transition-[background-color] hover:bg-paper focus-visible:outline-2 focus-visible:outline-cobalt focus-visible:-outline-offset-2"
            >
                <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                        <span lang={tag} className="font-medium text-[16px]">
                            {name}
                        </span>
                        <span className="font-mono text-[11px] text-faint">{tag}</span>
                    </span>
                    <span className="mt-0.5 block text-[13px] text-graphite">{detail}</span>
                </span>
                <Icon
                    name="next"
                    className="text-faint transition-[translate,color] group-hover:translate-x-0.5 group-hover:text-cobalt"
                />
            </a>
        </li>
    )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
    return (
        <li className="grid grid-cols-[1.75rem_1fr] gap-2">
            <span className="mt-0.5 grid size-6 place-items-center rounded-full bg-cobalt-soft font-mono text-[12px] text-cobalt">
                {n}
            </span>
            <span>
                <span className="font-medium">{title}.</span>{' '}
                <span className="text-graphite">{children}</span>
            </span>
        </li>
    )
}
