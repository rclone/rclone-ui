import { useState } from 'react'
import type { Counts } from './Editor.tsx'
import { makeZip } from './files.ts'
import type { Work } from './store.ts'
import type { Catalog, Shipped } from './types.ts'
import { buttons, Dialog, Icon, nativeName, number, percent } from './ui.tsx'

/** GitHub's page for adding files to main. For someone who can't push, it forks and opens a pull request. */
const UPLOAD = 'https://github.com/rclone/rclone-ui/upload/main'

export function DownloadDialog({
    open,
    onClose,
    catalog,
    work,
    shipped,
    isNew,
    counts,
    onShowProblems,
}: {
    open: boolean
    onClose: () => void
    catalog: Catalog
    work: Work
    shipped: Shipped
    isNew: boolean
    counts: { app: Counts; rclone: Counts }
    onShowProblems: () => void
}) {
    const [downloaded, setDownloaded] = useState(false)
    const fileName = `rclone-ui-${work.tag}.zip`
    const changed = Object.keys(work.edits).length
    const errors = counts.app.errors + counts.rclone.errors

    const download = () => {
        const zip = makeZip({
            catalog,
            isNew,
            translation: {
                tag: work.tag,
                name: work.name.trim() || nativeName(work.tag),
                pluralForms: work.pluralForms,
                values: (id) => work.edits[id] ?? shipped.values[id],
            },
            counts: {
                done: counts.app.done,
                total: counts.app.total,
                rcloneDone: counts.rclone.done,
                rcloneTotal: counts.rclone.total,
            },
        })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([zip.slice().buffer], { type: 'application/zip' }))
        a.download = fileName
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
        setDownloaded(true)
    }

    return (
        <Dialog
            open={open}
            onClose={() => {
                setDownloaded(false)
                onClose()
            }}
            title="Download your translation"
        >
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 font-mono text-[13px] tabular-nums">
                <dt className="text-graphite">The app</dt>
                <dd>
                    {number(counts.app.done)} / {number(counts.app.total)} texts,{' '}
                    {percent(counts.app.done, counts.app.total)}%
                </dd>
                <dt className="text-graphite">rclone&rsquo;s help</dt>
                <dd>
                    {number(counts.rclone.done)} / {number(counts.rclone.total)} texts,{' '}
                    {percent(counts.rclone.done, counts.rclone.total)}%
                </dd>
                {!isNew && (
                    <>
                        <dt className="text-graphite">Your changes</dt>
                        <dd>{number(changed)} texts</dd>
                    </>
                )}
            </dl>

            {errors > 0 && (
                <div className="mt-4 flex gap-2.5 rounded-lg bg-error/10 px-3 py-2.5 text-[13.5px] text-error">
                    <Icon name="warning" className="mt-0.5" />
                    <p>
                        {number(errors)}{' '}
                        {errors === 1 ? 'text has a problem' : 'texts have problems'} that would
                        show wrongly in the app. You can still download, but please fix them first.{' '}
                        <button
                            type="button"
                            className="font-medium underline underline-offset-2"
                            onClick={onShowProblems}
                        >
                            Show them
                        </button>
                    </p>
                </div>
            )}

            <div className="mt-5 flex items-center justify-between gap-3">
                <p className="font-mono text-[12px] text-faint">{fileName}</p>
                <button type="button" className={buttons.primary} onClick={download}>
                    <Icon name="download" />
                    Download
                </button>
            </div>

            <div
                className={`mt-5 rounded-xl px-4 py-3.5 text-[14px] leading-relaxed transition-[background-color] ${downloaded ? 'bg-cobalt-soft' : 'bg-paper'}`}
            >
                <p className="font-medium">Then open a pull request</p>
                <p className="mt-1 text-graphite">
                    Unzip the file, and drag its{' '}
                    <code className="font-mono text-[13px]">locales</code> folder onto
                    GitHub&rsquo;s upload page. GitHub makes the pull request for you.
                </p>
                <p className="mt-2 text-graphite">
                    You can also upload the zip as it is. Either way is fine: a good translation
                    matters more to us than how it arrives. Words you weren&rsquo;t sure about can
                    go in the pull request&rsquo;s description.
                </p>
                <a
                    href={UPLOAD}
                    target="_blank"
                    rel="noreferrer"
                    className={`${buttons.secondary} mt-3`}
                >
                    Open a pull request
                    <Icon name="next" className="size-3.5" />
                </a>
                <p className="mt-3 text-[13px] text-faint">
                    Your work stays in this browser, so you can keep going and send a newer file
                    later.
                </p>
            </div>
        </Dialog>
    )
}
