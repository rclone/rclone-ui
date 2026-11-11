import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react'
import {
    ArrowUpRightSmall as ArrowUpRightIcon,
    MessagePlus as MessagePlusIcon,
} from '@zappicon/react'
import type { ReactNode } from 'react'
import { openUrl } from '../../../lib/shell'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'

/** A new, blank issue. The repository has no issue templates, so GitHub opens the form at once. */
const NEW_ISSUE = 'https://github.com/rclone/rclone-ui/issues/new'

const CODE = 'px-1 py-0.5 rounded-md bg-default-100 font-mono text-[0.9em] text-foreground'
const STRONG = 'font-semibold text-foreground'
const PARAGRAPH = 'text-small leading-relaxed text-default-600 text-pretty'

const LIMITS: { title: string; body: ReactNode[] }[] = [
    {
        title: 'Custom rclone binaries',
        body: [
            'Rclone UI does not officially support custom rclone binaries. Differences between builds can introduce compatibility issues and unexpected behavior that we cannot reliably account for.',
            'If you need a custom binary, we recommend compiling your own version of Rclone UI with it.',
            "Thanks to the project's clean and straightforward architecture, tools like Claude or Codex can help you make the necessary changes and test them locally, often in around 30–60 minutes.",
        ],
    },
    {
        title: 'Connections to remote hosts or servers',
        body: [
            'Rclone UI does not support connecting to or managing rclone instances running on remote hosts.',
            <>
                For remote access, we recommend using <code className={CODE}>rclone gui</code> on
                your server or <strong className={STRONG}>Rclone Cloud</strong>. Both are free and
                can be accessed remotely from a web browser.
            </>,
        ],
    },
    {
        title: 'Workflow automation',
        body: [
            'Rclone UI will not include a workflow automation engine.',
            'Reliable workflow automation requires careful handling of failures, retries, recovery, and data integrity. These are not areas where shortcuts are acceptable. A hastily developed or sloppy implementation could lead to failed operations, inconsistent results, or even data loss.',
            "Integrating an established workflow engine would offer better reliability, but could also double or triple the application's size, which conflicts with Rclone UI's lightweight design.",
            <>
                <strong className={STRONG}>
                    We believe workflow automation should be implemented properly or not at all.
                </strong>{' '}
                Rather than introduce a feature we cannot confidently support, we prefer to leave it
                to tools specifically designed for that purpose.
            </>,
            <>
                If you need comprehensive workflow automation beyond what's available in current
                rclone interfaces, we recommend <strong className={STRONG}>Rclone Cloud</strong>.
            </>,
        ],
    },
    {
        title: 'Niche environments and configurations',
        body: [
            'We cannot realistically test and support every combination of operating system, Linux distribution, kernel, and desktop environment.',
            <>
                If you encounter an issue specific to an uncommon configuration,{' '}
                <strong className={STRONG}>
                    we encourage you to investigate it locally and submit a pull request with a
                    working fix
                </strong>
                , rather than opening an issue without a proposed solution.
            </>,
            'The project is open source, and tools like Codex or Claude can help you debug and resolve problems in your environment.',
            <>
                <strong className={STRONG}>AI-generated pull requests are welcome</strong>, provided
                they're submitted by a human. Ideally, contributors should understand the changes
                they're proposing, but programming experience is not a requirement. Even if you're a
                complete beginner, a tested fix is a valuable contribution.
            </>,
        ],
    },
    {
        title: 'Built-in file explorer',
        body: [
            'Rclone UI will not include a clone of Finder, Nautilus, or Windows Explorer.',
            'Your operating system already provides a mature, reliable file manager. Vibecoding that functionality inside Rclone UI would add substantial complexity, duplicate existing capabilities, and likely deliver a less polished experience. Your data is more valuable than that.',
            'We prefer to focus on functionality that complements your existing file manager rather than replaces it.',
        ],
    },
]

/**
 * What Rclone UI leaves out on purpose, shown before the user goes to GitHub to ask for a
 * feature. "Continue to GitHub" opens a new issue, and the dialog closes either way.
 *
 * It is always in English, like the issue that it leads to, so none of it is translated.
 */
export function FeatureRequestNotice({
    isOpen,
    onOpenChange,
}: {
    isOpen: boolean
    onOpenChange: (isOpen: boolean) => void
}) {
    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            size="2xl"
            placement="center"
            scrollBehavior="inside"
        >
            <ModalContent lang="en">
                {(close) => (
                    <>
                        <ModalHeader className="flex items-start gap-4 px-6 pt-6 pb-4">
                            <IconTile icon={MessagePlusIcon} tone="orange" size="lg" />
                            <div className="flex flex-col min-w-0 gap-1">
                                <span className="text-[15px] font-semibold leading-snug">
                                    Before opening a feature request
                                </span>
                                <span className="text-small font-normal leading-relaxed text-default-500 text-pretty">
                                    To keep the project focused and maintainable, certain features
                                    and use cases are intentionally outside its scope. Please review
                                    the following limitations before submitting a feature request.
                                </span>
                            </div>
                        </ModalHeader>
                        <ModalBody className="gap-6 px-6 pt-1 pb-4">
                            <ol className="flex flex-col gap-5">
                                {LIMITS.map((limit, index) => (
                                    <li key={limit.title} className="flex gap-3.5">
                                        <span className="grid shrink-0 size-6 mt-px place-items-center rounded-full bg-default-100 text-xs font-semibold tabular-nums text-default-600">
                                            {index + 1}
                                        </span>
                                        <div className="flex flex-col min-w-0 gap-1.5">
                                            <h3 className="text-small font-semibold leading-snug">
                                                {limit.title}
                                            </h3>
                                            {limit.body.map((paragraph, at) => (
                                                // The paragraphs never move.
                                                <p key={at} className={PARAGRAPH}>
                                                    {paragraph}
                                                </p>
                                            ))}
                                        </div>
                                    </li>
                                ))}
                            </ol>
                            <section className="flex flex-col gap-1.5 p-4 rounded-xl bg-default-100/70">
                                <h3 className="text-small font-semibold leading-snug">
                                    A note on project scope
                                </h3>
                                <p className={PARAGRAPH}>
                                    These limitations are intentional design decisions, not features
                                    waiting to be added.
                                </p>
                                <p className={PARAGRAPH}>
                                    <strong className={STRONG}>
                                        Our goal is to do a focused set of things well, rather than
                                        turn Rclone UI into an all-in-one management platform.
                                    </strong>
                                </p>
                                <p className={PARAGRAPH}>
                                    We welcome suggestions and contributions that improve the
                                    application's existing functionality, usability, compatibility,
                                    and reliability. However, feature requests covering the
                                    capabilities listed above will generally be closed.
                                </p>
                                <p className={PARAGRAPH}>
                                    If your needs extend beyond the project's scope, you're welcome
                                    to fork and customize Rclone UI. Its open-source nature and
                                    simple architecture are intended to make that process
                                    accessible.
                                </p>
                            </section>
                        </ModalBody>
                        <ModalFooter className="gap-2 px-6 pt-3 pb-5 border-t border-divider">
                            <Button variant="flat" onPress={close}>
                                Cancel
                            </Button>
                            <Button
                                color="primary"
                                className={toneButton('orange')}
                                endContent={<ArrowUpRightIcon className="size-4" />}
                                onPress={() => {
                                    close()
                                    openUrl(NEW_ISSUE).catch((error: unknown) =>
                                        console.error('[Settings] could not open GitHub', error)
                                    )
                                }}
                            >
                                Continue to GitHub
                            </Button>
                        </ModalFooter>
                    </>
                )}
            </ModalContent>
        </Modal>
    )
}
