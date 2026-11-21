import { useRef, useState } from 'react'
import { mergeInto } from './Editor.tsx'
import { readFiles } from './files.ts'
import { gettextExamples } from './plurals.ts'
import { go, removeWork, type Work } from './store.ts'
import type { Catalog, Shipped } from './types.ts'
import { buttons, Dialog, Icon, number } from './ui.tsx'

export async function filesOf(list: FileList | null) {
    return Promise.all(
        [...(list ?? [])].map(async (f) => ({
            name: f.name,
            data: new Uint8Array(await f.arrayBuffer()),
        }))
    )
}

export function LanguageDialog({
    open,
    onClose,
    catalog,
    work,
    shipped,
    isNew,
    onChange,
}: {
    open: boolean
    onClose: () => void
    catalog: Catalog
    work: Work
    shipped: Shipped
    isNew: boolean
    onChange: (update: (w: Work) => Work) => void
}) {
    const input = useRef<HTMLInputElement>(null)
    const [note, setNote] = useState('')
    const forms = gettextExamples(work.pluralForms)
    const changed = Object.keys(work.edits).length

    const open_ = async (list: FileList | null) => {
        const opened = readFiles(catalog, await filesOf(list))
        const found = Object.keys(opened.values).length
        if (opened.tag && opened.tag !== work.tag) {
            setNote(`That file is for ${opened.tag}, not ${work.tag}. Open it from the start page.`)
            return
        }
        if (!found) {
            setNote('That file has no texts that the app has now.')
            return
        }
        onChange((w) => ({
            ...mergeInto(w, opened.values, shipped),
            pluralForms: isNew && opened.pluralForms ? opened.pluralForms : w.pluralForms,
        }))
        setNote(`Opened ${number(found)} texts.`)
    }

    const field =
        'mt-1.5 block w-full rounded-lg bg-paper px-3 py-2 text-sm shadow-[inset_0_0_0_1px_var(--line)] outline-none read-only:text-graphite focus:shadow-[inset_0_0_0_1.5px_var(--cobalt)]'

    return (
        <Dialog
            open={open}
            onClose={() => {
                setNote('')
                onClose()
            }}
            title="Language"
        >
            <div className="space-y-4">
                <label className="block">
                    <span className="font-medium text-sm">
                        Name in the app&rsquo;s language list
                    </span>
                    <input
                        value={work.name}
                        readOnly={!isNew}
                        lang={work.tag}
                        onChange={(e) => onChange((w) => ({ ...w, name: e.target.value }))}
                        className={field}
                    />
                    <span className="mt-1 block text-[12.5px] text-faint">
                        Its own name, as its speakers write it. Language code:{' '}
                        <span className="font-mono">{work.tag}</span>
                    </span>
                </label>
                <label className="block">
                    <span className="font-medium text-sm">How it counts</span>
                    <input
                        value={work.pluralForms}
                        readOnly={!isNew}
                        onChange={(e) => onChange((w) => ({ ...w, pluralForms: e.target.value }))}
                        className={`${field} font-mono text-[12.5px]`}
                    />
                    <span className="mt-1 block text-[12.5px] text-faint leading-snug">
                        The rule that picks a form for a number in the app&rsquo;s messages
                        (gettext&rsquo;s Plural-Forms).{' '}
                        {forms.length === 1
                            ? 'One form for every number.'
                            : `${forms.length} forms: ${forms.map((f) => f || 'none up to 1,000').join(' / ')}.`}
                    </span>
                </label>
            </div>

            <div className="mt-6 space-y-3 border-line border-t pt-4">
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        className={buttons.secondary}
                        onClick={() => input.current?.click()}
                    >
                        <Icon name="upload" />
                        Open a file
                    </button>
                    <input
                        ref={input}
                        type="file"
                        multiple={true}
                        accept=".zip,.po,.json"
                        className="hidden"
                        onChange={(e) => {
                            open_(e.target.files).catch(() =>
                                setNote('That file could not be read.')
                            )
                            e.target.value = ''
                        }}
                    />
                    <span className="text-[13px] text-graphite" role="status">
                        {note ||
                            'A file that you downloaded here, or app.po, core.po or rclone.json.'}
                    </span>
                </div>
                {(changed > 0 || isNew) && (
                    <button
                        type="button"
                        className={`${buttons.ghost} text-error hover:text-error`}
                        onClick={() => {
                            const what = isNew
                                ? `all your work on ${work.name}`
                                : `your ${number(changed)} changes to ${work.name}`
                            if (
                                !confirm(
                                    `Delete ${what} from this browser? Download it first if you want to keep it.`
                                )
                            )
                                return
                            removeWork(work.tag)
                            onChange((w) => ({ ...w, edits: {} }))
                            if (isNew) go()
                        }}
                    >
                        Delete my work in this browser
                    </button>
                )}
            </div>
        </Dialog>
    )
}
