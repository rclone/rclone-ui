import { Button, Checkbox, Listbox, ListboxItem, type Selection, Skeleton } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Check as CheckIcon } from '@zappicon/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Transfers } from '../../../lib/core/types'
import { coreError, formatErrorMessage } from '../../../lib/errors'
import { formatNumber } from '../../../lib/format'
import { retryTransfer, useRetryable, useTransfer } from '../../../lib/transfers'
import { errorReason } from '../../../lib/transfers/retry'
import Alert from '../../components/Alert'
import EmptyState from '../../components/EmptyState'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import { Panel } from '../../components/look/Panel'
import { toastSuccess } from '../../components/toast'
import { WINDOWS } from '../../routes'
import { transferName } from './describe'
import { ArrowRotateLeftIcon, lookOfOperation } from './rows'
import { BackBar, GeneralErrors, RetryRefused, TransferNotFound } from './TransferDetails'

const ROW_HEIGHT = 56

/** The list key of a retry item: the key that Retry sends back, as text. */
const keyOf = (item: Transfers.RetryItem) => JSON.stringify(item.key)

/**
 * Lists what failed in transfer `id`, so that the user can pick what to retry. One, some or all
 * of the failures run as a single new transfer. The core decides what can be retried
 * (Retryable). Once the retry starts, its details open.
 */
export default function TransferRetry({
    id,
    onBack,
    onHistory,
    onStarted,
}: {
    id: string
    /** Goes back to the transfer's details. */
    onBack: () => void
    /** Goes back to the list, when the transfer is gone. */
    onHistory: () => void
    onStarted: (id: string) => void
}) {
    const { transfer: detail, query: detailQuery } = useTransfer(id)
    const { retryable, query } = useRetryable(id)
    const transfer = detail?.transfer
    const items = retryable?.items ?? []
    // When this version of the app refuses the retry, there is nothing to pick, so the reason
    // is shown instead.
    const refused = retryable?.refused ?? ''
    const allKeys = useMemo(() => items.map(keyOf), [items])
    // Everything starts selected, because retrying all of it is the common case and then takes
    // one click.
    const [selected, setSelected] = useState<Set<string> | null>(null)
    const chosen = selected ?? new Set(allKeys)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    if (coreError(detailQuery.error)?.code === 'not_found') {
        return <TransferNotFound onBack={onHistory} />
    }
    const back = <BackBar label={transfer ? transferName(transfer) : t`Back`} onBack={onBack} />
    if (!transfer || query.isLoading) {
        return (
            <>
                {back}
                {query.isError || detailQuery.isError ? (
                    <EmptyState
                        icon={ArrowRotateLeftIcon}
                        tone={WINDOWS.history.tone}
                        title={t`Couldn't load the failures`}
                        description={formatErrorMessage(query.error ?? detailQuery.error)}
                        className="flex-1"
                    />
                ) : (
                    <div
                        aria-busy={true}
                        aria-label={t`Loading`}
                        className="flex flex-col gap-4 px-6 pt-3"
                    >
                        <div className="flex items-center gap-3.5">
                            <Skeleton className="size-12 rounded-[14px]" />
                            <div className="flex flex-col gap-2">
                                <Skeleton className="w-36 h-5 rounded-md" />
                                <Skeleton className="h-3.5 rounded-md w-80" />
                            </div>
                        </div>
                        <Skeleton className="w-full h-48 rounded-2xl" />
                    </div>
                )}
            </>
        )
    }
    if (!refused && (transfer.endedAt === null || items.length === 0)) {
        return (
            <>
                {back}
                <EmptyState
                    icon={ArrowRotateLeftIcon}
                    tone={WINDOWS.history.tone}
                    title={t`Nothing to retry`}
                    description={t`Only the failed items of a transfer that has ended can be retried.`}
                    actions={
                        <Button variant="flat" onPress={onBack} data-focus-visible="false">
                            <Trans>Back to the transfer</Trans>
                        </Button>
                    }
                />
            </>
        )
    }

    const retry = async () => {
        setPending(true)
        setError(null)
        try {
            const keys = items.filter((item) => chosen.has(keyOf(item))).map((item) => item.key)
            const started = await retryTransfer(transfer.id, keys)
            const seq = started.seq
            toastSuccess(t`Retry started as #${seq}`)
            onStarted(started.id)
        } catch (failure) {
            // A retry that was recorded before it failed is shown, with why it failed.
            const recorded = coreError(failure)?.transfer
            if (recorded) {
                onStarted(recorded.id)
                return
            }
            setError(formatErrorMessage(failure, t`The retry could not start.`))
        } finally {
            setPending(false)
        }
    }

    const look = lookOfOperation(transfer.operation)
    const picked = chosen.size
    const total = formatNumber(items.length)
    return (
        <div className="flex flex-col flex-1 min-h-0">
            {back}
            <div className="flex flex-col gap-4 px-6 pt-3 pb-4 shrink-0">
                <header className="flex items-center gap-3.5">
                    <IconTile icon={ArrowRotateLeftIcon} tone={look.tone} size="xl" />
                    <div className="flex flex-col gap-0.5">
                        <h1 className="text-2xl font-semibold leading-tight tracking-tight font-rounded">
                            <Trans comment="Title: pick the failed files to run again.">
                                Retry failed
                            </Trans>
                        </h1>
                        <p className="leading-snug text-small text-default-500 text-pretty">
                            {refused
                                ? transferName(transfer)
                                : t`What you pick runs as one new transfer, with the same settings.`}
                        </p>
                    </div>
                </header>
                {refused ? (
                    <RetryRefused reason={refused} />
                ) : (
                    <>
                        <GeneralErrors general={retryable?.general ?? []} />
                        {error && (
                            <Alert color="danger" variant="faded">
                                {error}
                            </Alert>
                        )}
                    </>
                )}
            </div>
            {!refused && (
                <div className="flex flex-col flex-1 min-h-0 px-6 pb-4">
                    <Panel className="flex flex-col flex-1 min-h-0 overflow-hidden">
                        <div className="flex flex-row items-center justify-between gap-2 px-4 py-2.5 border-b border-divider">
                            <Checkbox
                                isSelected={chosen.size === items.length}
                                isIndeterminate={chosen.size > 0 && chosen.size < items.length}
                                onValueChange={(all) => setSelected(new Set(all ? allKeys : []))}
                            >
                                <span className="text-sm font-medium">
                                    <Trans>Select all</Trans>
                                </span>
                            </Checkbox>
                            <p className="text-xs tabular-nums text-default-500">
                                {plural(picked, {
                                    one: `# of ${total} selected`,
                                    other: `# of ${total} selected`,
                                })}
                            </p>
                        </div>
                        <FailedFiles
                            items={items}
                            chosen={chosen}
                            onChange={(keys) =>
                                setSelected(
                                    new Set(keys === 'all' ? allKeys : (keys as Set<string>))
                                )
                            }
                        />
                    </Panel>
                </div>
            )}
            <div className="flex justify-end gap-2 px-6 pt-1 pb-5 shrink-0">
                <Button variant="light" onPress={onBack}>
                    <Trans>Cancel</Trans>
                </Button>
                {!refused && (
                    <Button
                        color="primary"
                        className={toneButton(look.tone)}
                        isDisabled={chosen.size === 0}
                        isLoading={pending}
                        startContent={
                            pending ? undefined : <ArrowRotateLeftIcon className="w-4 h-4" />
                        }
                        onPress={retry}
                    >
                        {plural(picked, { one: 'Retry # selected', other: 'Retry # selected' })}
                    </Button>
                )}
            </div>
        </div>
    )
}

/**
 * The failures to pick from. The list is virtualized, because a bad run can fail thousands of
 * files, so it needs to be given its height. The height is measured here, in a component that
 * mounts only after the failures have loaded, so the area to measure is already on screen.
 */
function FailedFiles({
    items,
    chosen,
    onChange,
}: {
    items: Transfers.RetryItem[]
    chosen: Set<string>
    onChange: (keys: Selection) => void
}) {
    const listArea = useRef<HTMLDivElement>(null)
    const [listHeight, setListHeight] = useState(320)
    useEffect(() => {
        if (!listArea.current) return
        const observer = new ResizeObserver(([entry]) => setListHeight(entry.contentRect.height))
        observer.observe(listArea.current)
        return () => observer.disconnect()
    }, [])

    return (
        <div ref={listArea} className="flex-1 min-h-40">
            <Listbox
                aria-label={t`Failed files`}
                items={items}
                isVirtualized={true}
                virtualization={{
                    maxListboxHeight: listHeight,
                    itemHeight: ROW_HEIGHT,
                }}
                selectionMode="multiple"
                selectedKeys={chosen}
                onSelectionChange={onChange}
                hideSelectedIcon={true}
                classNames={{ base: 'p-0', list: 'gap-0' }}
            >
                {(item) => (
                    <ListboxItem
                        key={keyOf(item)}
                        textValue={item.label}
                        // The check mark is styled from the row's own `data-selected`, because
                        // the virtualized list doesn't re-render its rows when the selection
                        // changes.
                        startContent={
                            <span
                                aria-hidden={true}
                                className="flex items-center justify-center size-5 mx-1 shrink-0 rounded-md border-2 border-default-300 group-data-[selected=true]:bg-primary group-data-[selected=true]:border-primary"
                            >
                                <CheckIcon className="hidden size-3.5 text-primary-foreground group-data-[selected=true]:block" />
                            </span>
                        }
                        // A long path is shortened in its folders, never in the file name,
                        // because the file name is what users pick a row by.
                        title={<PathLabel path={item.label} />}
                        description={<span title={item.error}>{errorReason(item.error)}</span>}
                        classNames={{
                            base: 'h-14 px-3 rounded-none border-b border-divider',
                            wrapper: 'min-w-0',
                            title: 'w-full min-w-0 font-medium',
                            description: 'truncate text-danger-600 dark:text-danger-500',
                        }}
                    />
                )}
            </Listbox>
        </div>
    )
}

function PathLabel({ path }: { path: string }) {
    const cut = path.lastIndexOf('/') + 1
    return (
        <span className="flex flex-row w-full min-w-0 overflow-hidden" title={path}>
            {cut > 0 && (
                <span className="min-w-0 truncate text-default-500">{path.slice(0, cut)}</span>
            )}
            <span className="max-w-full truncate shrink-0">{path.slice(cut)}</span>
        </span>
    )
}
