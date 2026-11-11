import {
    Button,
    Link,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
    Spinner,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    Check as CheckIcon,
    Clipboard as ClipboardIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    TerminalSquare as TerminalSquareIcon,
} from '@zappicon/react'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import type { Operations } from '../../../lib/core/types'
import { formatErrorMessage } from '../../../lib/errors'
import { clipboard, message, openUrl } from '../../../lib/shell'
import { IconTile } from '../look/IconTile'
import { pageLook, pageName } from './look'

type State = { script: Operations.Script } | { error: string } | undefined

const SDK_LINKS = [
    { label: 'GitHub', url: 'https://github.com/rclone-ui/rclone-sdk' },
    { label: 'npm', url: 'https://www.npmjs.com/package/rclone-sdk' },
    { label: 'crates.io', url: 'https://crates.io/crates/rclone-sdk' },
]

const CODE =
    'font-mono rounded-xl bg-default-100/70 dark:bg-default-100/50 leading-relaxed select-text'

/**
 * A command line that wraps only between its words, so a flag such as --create-empty-src-dirs
 * stays whole. A word longer than the row, such as a long path, still wraps inside itself.
 */
function Words({ line }: { line: string }) {
    return line.split(' ').map((word, index) => (
        // The words never move, so the index is a safe key.
        <Fragment key={index}>
            {index > 0 && ' '}
            <span className="inline-block max-w-full [overflow-wrap:anywhere]">{word}</span>
        </Fragment>
    ))
}

function CopyButton({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false)
    useEffect(() => {
        if (!copied) return
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
    }, [copied])
    return (
        <Button
            size="sm"
            variant="flat"
            aria-label={label}
            onPress={() =>
                clipboard.setText(text).then(
                    () => setCopied(true),
                    (error: unknown) =>
                        message(formatErrorMessage(error), { title: label, kind: 'error' })
                )
            }
            startContent={
                copied ? <CheckIcon className="size-4" /> : <ClipboardIcon className="size-4" />
            }
        >
            {copied
                ? t({ message: 'Copied', comment: 'Button, after its text was copied.' })
                : t({ message: 'Copy', context: 'to the clipboard' })}
        </Button>
    )
}

function Section({
    title,
    copy,
    copyLabel,
    note,
    children,
}: {
    title: string
    copy: string
    copyLabel: string
    note: ReactNode
    children: ReactNode
}) {
    return (
        <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 px-1">
                <h3 className="font-semibold text-small">{title}</h3>
                <CopyButton text={copy} label={copyLabel} />
            </div>
            <p className="px-1 text-tiny text-default-500 text-pretty">{note}</p>
            {children}
        </section>
    )
}

function purpose(): string {
    switch (pageName()) {
        case 'copy':
            return t`This copy, to run from the terminal or a script`
        case 'move':
            return t`This move, to run from the terminal or a script`
        case 'sync':
            return t`This sync, to run from the terminal or a script`
        case 'bisync':
            return t`This bisync, to run from the terminal or a script`
        case 'delete':
            return t`This delete, to run from the terminal or a script`
        case 'purge':
            return t`This purge, to run from the terminal or a script`
        case 'mount':
            return t`This mount, to run from the terminal or a script`
        case 'serve':
            return t`This serve, to run from the terminal or a script`
        case 'download':
            return t`This download, to run from the terminal or a script`
        default:
            return t`This operation, to run from the terminal or a script`
    }
}

/**
 * "Copy command" from an operation page's More menu: the page's operation, to run outside the
 * app. The CLI section has it as rclone commands for a terminal or a script, and the SDK section
 * as a program for rclone-sdk, which runs it through rclone's API. The core writes both from the
 * same form that Start sends, so they run what the page would run. A page that can't start yet
 * says why instead.
 */
export function CommandModal({
    isOpen,
    onClose,
    command,
}: {
    isOpen: boolean
    onClose: () => void
    /** The page's operation for a script, or the reason the page can't start. */
    command: () => Promise<Operations.Script>
}) {
    const look = pageLook()
    const [state, setState] = useState<State>()
    // The page makes a new `command` on every render, and only an opening asks for it.
    const latest = useRef(command)
    latest.current = command

    // The script is written each time the dialog opens, from the form as it is then.
    useEffect(() => {
        if (!isOpen) return
        let current = true
        setState(undefined)
        latest.current().then(
            (script) => current && setState({ script }),
            (error: unknown) => current && setState({ error: formatErrorMessage(error) })
        )
        return () => {
            current = false
        }
    }, [isOpen])

    const script = state && 'script' in state ? state.script : undefined
    const several = !!script && script.lines.length > 1

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
            <ModalContent>
                <ModalHeader className="flex items-center gap-3.5 pt-6">
                    <IconTile icon={TerminalSquareIcon} tone={look.tone} size="lg" />
                    <div className="flex flex-col min-w-0">
                        <span className="text-[15px] font-semibold leading-snug">
                            <Trans>Command</Trans>
                        </span>
                        <span className="text-xs font-normal text-default-500">{purpose()}</span>
                    </div>
                </ModalHeader>
                <ModalBody className="gap-6 pb-2">
                    {!state && (
                        <div className="flex justify-center py-6">
                            <Spinner size="sm" />
                        </div>
                    )}
                    {script && (
                        <>
                            <Section
                                title={t({
                                    message: 'CLI',
                                    comment: 'Section title: rclone commands for a terminal.',
                                })}
                                copy={script.lines.join('\n')}
                                copyLabel={several ? t`Copy the commands` : t`Copy the command`}
                                note={
                                    several
                                        ? t`They use the rclone on your PATH. Settings for the whole app, such as the bandwidth limit, are left out.`
                                        : t`It uses the rclone on your PATH. Settings for the whole app, such as the bandwidth limit, are left out.`
                                }
                            >
                                <div className={`flex flex-col p-1 text-[13px] ${CODE}`}>
                                    {script.lines.map((line, index) => (
                                        <code
                                            // A script may hold the same line twice, and the
                                            // lines never move.
                                            key={index}
                                            className="block px-2.5 py-2 not-first:border-t border-divider"
                                        >
                                            <Words line={line} />
                                        </code>
                                    ))}
                                </div>
                            </Section>
                            <Section
                                title={t({
                                    message: 'SDK',
                                    comment: 'Section title: a program for rclone-sdk.',
                                })}
                                copy={script.sdk}
                                copyLabel={t`Copy the program`}
                                note={
                                    <>
                                        <Trans>
                                            rclone-sdk is a typed client for rclone's API, in
                                            TypeScript and Rust.
                                        </Trans>{' '}
                                        {SDK_LINKS.map((link, index) => (
                                            <Fragment key={link.url}>
                                                {index > 0 && ' · '}
                                                <Link
                                                    as="button"
                                                    size="sm"
                                                    className="text-tiny"
                                                    onPress={() => {
                                                        openUrl(link.url).catch((error: unknown) =>
                                                            console.error(
                                                                '[CommandModal] could not open',
                                                                link.url,
                                                                error
                                                            )
                                                        )
                                                    }}
                                                >
                                                    {link.label}
                                                </Link>
                                            </Fragment>
                                        ))}
                                    </>
                                }
                            >
                                <pre
                                    className={`px-3.5 py-3 overflow-x-auto whitespace-pre text-[12.5px] ${CODE}`}
                                >
                                    <code>{script.sdk}</code>
                                </pre>
                            </Section>
                        </>
                    )}
                    {state && 'error' in state && (
                        <div
                            role="alert"
                            className="flex gap-2.5 p-3 text-sm rounded-xl bg-danger/10 text-danger-600 dark:text-danger-500"
                        >
                            <ExclamationTriangleIcon className="size-4 mt-0.5 shrink-0" />
                            <p className="whitespace-pre-line [overflow-wrap:anywhere]">
                                {state.error}
                            </p>
                        </div>
                    )}
                </ModalBody>
                <ModalFooter className="pt-3 pb-5">
                    <Button variant="flat" onPress={onClose}>
                        <Trans>Close</Trans>
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    )
}
