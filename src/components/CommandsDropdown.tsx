import {
    Button,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownSection,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    BookOpen as BookOpenIcon,
    Eye as EyeIcon,
    MoreHorizontalCircle as MoreHorizontalCircleIcon,
    TerminalSquare as TerminalSquareIcon,
} from '@zappicon/react'
import { onErrorDialog } from '../../lib/errors'
import { openUrl, openWindow, platform } from '../../lib/shell'
import { WINDOWS } from '../routes'
import { IconTile } from './look/IconTile'

/** The operations that the menu opens, in the launcher's order. */
const COMMANDS = [
    'download',
    'copy',
    'move',
    'delete',
    'sync',
    'bisync',
    'purge',
    'serve',
    'mount',
] as const

const PREVIEW = 'preview'
const DOCS = 'docs'
const COMMAND = 'command'

/**
 * A menu of the operations, which opens the window of the one picked. On an operation page it is
 * the header's More menu: it also offers a dry run, the page's rclone command and the command's
 * page in the rclone docs, and the current operation is disabled. With a `title`, the trigger is
 * a button with that text (as in History's empty state).
 */
export default function CommandsDropdown({
    currentCommand,
    docs,
    preview,
    onCopyCommand,
    title,
}: {
    currentCommand?: string
    /** The command's page on rclone.org, which the first item opens. */
    docs?: string
    /** Starts a dry run of the page's operation. Disabled while the page can't start. */
    preview?: { run: () => unknown; isDisabled: boolean }
    /** Shows the page's operation as rclone commands and as a program (CommandModal). */
    onCopyCommand?: () => void
    /** The button's text, translated by the caller. Without it, the button is the More icon. */
    title?: string
}) {
    const more = t({ message: 'More', comment: 'Button: opens a menu of more actions.' })
    return (
        <Dropdown shadow={platform() === 'windows' ? 'none' : undefined} placement="bottom-end">
            {title ? (
                <DropdownTrigger>
                    <Button size="lg" type="button" color="primary">
                        {title}
                    </Button>
                </DropdownTrigger>
            ) : (
                <Tooltip content={more} placement="bottom" delay={500} closeDelay={0}>
                    <div tabIndex={-1}>
                        <DropdownTrigger>
                            <Button
                                type="button"
                                variant="flat"
                                isIconOnly={true}
                                aria-label={more}
                                className="text-default-600"
                                data-focus-visible="false"
                            >
                                <MoreHorizontalCircleIcon className="size-5" />
                            </Button>
                        </DropdownTrigger>
                    </div>
                </Tooltip>
            )}
            <DropdownMenu
                aria-label={title ?? more}
                onAction={(key) => {
                    if (key === PREVIEW) {
                        preview?.run()
                        return
                    }
                    if (key === COMMAND) {
                        onCopyCommand?.()
                        return
                    }
                    if (key === DOCS) {
                        if (!docs) return
                        openUrl(docs).catch((error: unknown) =>
                            console.error('[CommandsDropdown] could not open the docs', error)
                        )
                        return
                    }
                    openWindow(`/${key as string}`).catch(
                        onErrorDialog(t`Couldn't open the window`)
                    )
                }}
                disabledKeys={[
                    ...(currentCommand ? [currentCommand] : []),
                    ...(preview?.isDisabled ? [PREVIEW] : []),
                ]}
            >
                {docs || onCopyCommand || preview ? (
                    <DropdownSection showDivider={true}>
                        {[
                            ...(preview
                                ? [
                                      <DropdownItem
                                          key={PREVIEW}
                                          startContent={
                                              <EyeIcon className="size-5 text-default-500" />
                                          }
                                          description={t`A dry run simulates the operation without changing anything`}
                                      >
                                          <Trans comment="Menu item: starts a dry run of the operation.">
                                              Preview
                                          </Trans>
                                      </DropdownItem>,
                                  ]
                                : []),
                            ...(onCopyCommand
                                ? [
                                      <DropdownItem
                                          key={COMMAND}
                                          startContent={
                                              <TerminalSquareIcon className="size-5 text-default-500" />
                                          }
                                          description={t`For a terminal or a script`}
                                      >
                                          <Trans>Copy command</Trans>
                                      </DropdownItem>,
                                  ]
                                : []),
                            ...(docs
                                ? [
                                      <DropdownItem
                                          key={DOCS}
                                          startContent={
                                              <BookOpenIcon className="size-5 text-default-500" />
                                          }
                                          description={t`The command's page on rclone.org`}
                                      >
                                          <Trans>Rclone docs</Trans>
                                      </DropdownItem>,
                                  ]
                                : []),
                        ]}
                    </DropdownSection>
                ) : null}
                <DropdownSection title={title ? undefined : t`Run another command`}>
                    {COMMANDS.map((command) => {
                        const look = WINDOWS[command]
                        return (
                            <DropdownItem
                                key={command}
                                startContent={
                                    <IconTile icon={look.icon} tone={look.tone} size="sm" />
                                }
                            >
                                {look.title}
                            </DropdownItem>
                        )
                    })}
                </DropdownSection>
            </DropdownMenu>
        </Dropdown>
    )
}
