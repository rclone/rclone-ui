import {
    Button,
    cn,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
    Radio,
    RadioGroup,
    ScrollShadow,
    Switch,
} from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowRightSmall as ArrowRightSmallIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    Laptop as LaptopIcon,
} from '@zappicon/react'
import { useCallback, useEffect, useState } from 'react'
import type { Operations } from '../../../lib/core/types'
import { coreError, formatErrorMessage } from '../../../lib/errors'
import type { OperationSubset } from '../../../lib/operations'
import { formOf } from '../../../lib/operations'
import { baseName, localRoot, parsePath } from '../../../lib/paths'
import { startTransfer } from '../../../lib/transfers'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import { FileIcon } from '../../components/navigator'
import type { Entry, SelectItem } from '../../components/navigator/types'
import { WINDOWS } from '../../routes'

type DropOperation = OperationSubset<'copy' | 'move'>

/**
 * The arguments for the copy or move that a drop between the panels starts. The items are sent as
 * they were dropped, and the core asks rclone whether each one is a file or a folder.
 */
function startArgs(
    operation: DropOperation,
    items: SelectItem[],
    destination: string,
    overwrite: boolean
): Operations.CopyArgs {
    return {
        sources: items.map((item) => item.path),
        destination,
        options: {
            [operation]: overwrite ? {} : { ignore_existing: true },
            config: {},
            filter: {},
        },
    }
}

const LOCAL = t({
    message: 'Local',
    comment: 'Where a file is: on this computer, not on a remote.',
})

function actionWords(operation: DropOperation, count: number): string {
    return operation === 'copy'
        ? plural(count, { one: 'Copy # item', other: 'Copy # items' })
        : plural(count, { one: 'Move # item', other: 'Move # items' })
}

function destinationWords({ remote, fileName }: { remote: string; fileName: string }): string {
    if (!fileName) {
        return t({
            message: `to ${remote}`,
            comment: 'Where a drop goes: a remote, or Local for this computer.',
        })
    }
    return t({
        message: `to ${remote} · ${fileName}`,
        comment: 'Where a drop goes: a remote (or Local for this computer), then the folder.',
    })
}

export default function OperationDialog({
    items,
    destination,
    onClose,
    onJobStarted,
    onMoved,
}: {
    items: SelectItem[] | null
    destination: string | null
    onClose: () => void
    onJobStarted?: (id: string) => void
    /** Called when a move starts, with the items that are moving away from their folder. */
    onMoved?: (items: SelectItem[]) => void
}) {
    const [operation, setOperation] = useState<DropOperation>('copy')
    const [overwrite, setOverwrite] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const isOpen = !!items && items.length > 0
    // Each new drop starts as a copy that overwrites nothing, with no error from the last one.
    useEffect(() => {
        if (!isOpen) return
        setOperation('copy')
        setOverwrite(false)
        setError(null)
    }, [isOpen])

    const handleConfirm = useCallback(async () => {
        if (!items || !destination) return
        setIsLoading(true)
        setError(null)
        try {
            const form = formOf(operation, startArgs(operation, items, destination, overwrite))
            const id = await startTransfer(form, { origin: 'commander', preset: form })
            onJobStarted?.(id)
            if (operation === 'move') onMoved?.(items)
            onClose()
        } catch (failure) {
            // If the transfer was recorded before it failed, it is shown in the bar too. The error
            // is shown here, and the dialog stays open so the user can try again.
            const recorded = coreError(failure)?.transfer
            if (recorded) onJobStarted?.(recorded.id)
            setError(
                formatErrorMessage(
                    failure,
                    operation === 'copy' ? t`Copy operation failed` : t`Move operation failed`
                )
            )
        } finally {
            setIsLoading(false)
        }
    }, [items, destination, operation, overwrite, onJobStarted, onMoved, onClose])

    const itemCount = items?.length ?? 0

    // Splits the name the same way the core does, so on Windows a backslash also separates path
    // parts. A root has no name, so a local root is shown as itself (`C:\`).
    const formatPath = (path: string) => {
        const parsed = parsePath(path)
        const fileName = baseName(path)
        if (parsed.kind === 'remote') {
            return { remote: parsed.name, fileName, isRemote: true }
        }
        return { remote: LOCAL, fileName: fileName || localRoot(path), isRemote: false }
    }

    const destinationInfo = destination ? formatPath(destination) : null

    const look = operation === 'copy' ? WINDOWS.copy : WINDOWS.move
    const action = actionWords(operation, itemCount)
    const first = items?.[0]
    const firstInfo = first ? formatPath(first.path) : null

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="lg"
            hideCloseButton={isLoading}
            // While the transfer starts, the dialog stays open, so that a failed start shows here.
            isDismissable={!isLoading}
            isKeyboardDismissDisabled={isLoading}
        >
            <ModalContent>
                <ModalHeader className="flex items-center gap-3.5 pt-6">
                    <IconTile icon={look.icon} tone={look.tone} size="lg" />
                    <div className="flex flex-col min-w-0">
                        <span className="text-[15px] font-semibold leading-snug">{action}</span>
                        <span className="text-xs font-normal truncate text-default-500">
                            {destinationInfo && destinationWords(destinationInfo)}
                        </span>
                    </div>
                </ModalHeader>
                <ModalBody className="gap-5 pb-2">
                    <div className="grid items-center grid-cols-[1fr_auto_1fr] gap-2 p-2 rounded-xl bg-default-100/70 dark:bg-default-100/50">
                        <div className="flex items-center min-w-0 gap-2.5 px-2 py-1.5">
                            {first && firstInfo && (
                                <FileIcon
                                    entry={
                                        {
                                            key: first.path,
                                            name: firstInfo.fileName,
                                            isDir: first.type === 'folder',
                                            fullPath: first.path,
                                        } as Entry
                                    }
                                    size="lg"
                                />
                            )}
                            <div className="flex flex-col min-w-0">
                                <span className="text-sm font-medium truncate">
                                    {firstInfo?.fileName}
                                </span>
                                <span className="text-xs truncate text-default-500">
                                    {itemCount > 1
                                        ? plural(itemCount - 1, {
                                              one: 'and # more',
                                              other: 'and # more',
                                          })
                                        : firstInfo?.remote}
                                </span>
                            </div>
                        </div>
                        <span className="grid rounded-full size-7 place-items-center bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.08)] dark:bg-default-200">
                            <ArrowRightSmallIcon className="size-4 text-primary" />
                        </span>
                        <div className="flex items-center min-w-0 gap-2.5 px-2 py-1.5">
                            {destinationInfo?.isRemote ? (
                                <FileIcon
                                    entry={{ key: '', name: '', isDir: true, fullPath: '' }}
                                    size="lg"
                                />
                            ) : (
                                <LaptopIcon className="size-6 shrink-0 text-default-500" />
                            )}
                            <div className="flex flex-col min-w-0">
                                <span className="text-sm font-medium truncate">
                                    {destinationInfo?.fileName || '/'}
                                </span>
                                <span className="text-xs truncate text-default-500">
                                    {destinationInfo?.remote}
                                </span>
                            </div>
                        </div>
                    </div>

                    <RadioGroup
                        aria-label={t({
                            message: 'Operation',
                            comment: 'Copy or move: what a drop does.',
                        })}
                        value={operation}
                        onValueChange={(val) => setOperation(val as DropOperation)}
                        orientation="horizontal"
                        isDisabled={isLoading}
                        classNames={{ wrapper: 'grid grid-cols-2 gap-3' }}
                    >
                        {(
                            [
                                {
                                    value: 'copy',
                                    look: WINDOWS.copy,
                                    description: t`Keep original files`,
                                },
                                {
                                    value: 'move',
                                    look: WINDOWS.move,
                                    description: t`Delete after transfer`,
                                },
                            ] as const
                        ).map((option) => (
                            <Radio
                                key={option.value}
                                value={option.value}
                                description={option.description}
                                classNames={{
                                    base: cn(
                                        'm-0 max-w-none flex-row-reverse justify-between gap-3 p-3 rounded-xl cursor-pointer',
                                        'bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.08)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1)]',
                                        'transition-[box-shadow,background-color] duration-150',
                                        'data-[selected=true]:shadow-[0_0_0_2px_hsl(var(--heroui-primary))] data-[selected=true]:bg-primary/5'
                                    ),
                                    labelWrapper: 'ms-0',
                                    label: 'text-sm font-medium',
                                    description: 'text-xs text-default-500',
                                }}
                            >
                                <span className="flex items-center gap-2">
                                    <IconTile
                                        icon={option.look.icon}
                                        tone={option.look.tone}
                                        size="sm"
                                    />
                                    {option.look.title}
                                </span>
                            </Radio>
                        ))}
                    </RadioGroup>

                    {itemCount > 1 && (
                        <ScrollShadow className="max-h-36 -mx-1 px-1">
                            <ul className="flex flex-col">
                                {items?.map((item) => {
                                    const info = formatPath(item.path)
                                    const mockEntry = {
                                        key: item.path,
                                        name: info.fileName,
                                        isDir: item.type === 'folder',
                                        fullPath: item.path,
                                    } as Entry
                                    return (
                                        <li
                                            key={item.path}
                                            className="flex items-center gap-2.5 py-1.5 text-[13px] border-b border-divider last:border-b-0"
                                        >
                                            <FileIcon entry={mockEntry} size="sm" />
                                            <span className="flex-1 truncate">{info.fileName}</span>
                                            {info.isRemote && (
                                                <span className="px-1.5 py-0.5 text-[11px] rounded-md bg-default-100 text-default-600">
                                                    {info.remote}
                                                </span>
                                            )}
                                        </li>
                                    )
                                })}
                            </ul>
                        </ScrollShadow>
                    )}

                    <Switch
                        isSelected={overwrite}
                        onValueChange={setOverwrite}
                        isDisabled={isLoading}
                        size="sm"
                        classNames={{
                            base: 'flex-row-reverse justify-between max-w-none w-full gap-3',
                            wrapper: 'me-0',
                        }}
                    >
                        <span className="flex flex-col">
                            <span className="text-sm">
                                <Trans>Overwrite existing files</Trans>
                            </span>
                            <span className="text-xs text-default-500">
                                {overwrite
                                    ? t`Files with the same name at the destination are replaced.`
                                    : t`Files that are already at the destination are skipped.`}
                            </span>
                        </span>
                    </Switch>

                    {error && (
                        <div
                            role="alert"
                            className="flex gap-2.5 p-3 text-sm rounded-xl bg-danger/10 text-danger-600 dark:text-danger-500"
                        >
                            <ExclamationTriangleIcon className="size-4 mt-0.5 shrink-0" />
                            <p className="whitespace-pre-line [overflow-wrap:anywhere]">{error}</p>
                        </div>
                    )}
                </ModalBody>
                <ModalFooter className="pt-3 pb-5">
                    <Button variant="flat" onPress={onClose} isDisabled={isLoading}>
                        <Trans>Cancel</Trans>
                    </Button>
                    <Button
                        color="primary"
                        className={toneButton(look.tone)}
                        onPress={handleConfirm}
                        isLoading={isLoading}
                    >
                        {action}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    )
}
