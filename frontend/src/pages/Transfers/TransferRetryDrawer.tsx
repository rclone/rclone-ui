import {
    Button,
    Checkbox,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Listbox,
    ListboxItem,
} from '@heroui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { message } from '@/dialog'
import type { TransferDetail } from '@/server/transfers'
import { UserCancelledError } from '@/lib/errors'
import { notify } from '@/lib/notifications'
import { startRetry } from './startRetry'
import { type RetryItem, errorReason } from '@/lib/transfers/retry'
import type { TransferRow } from '@/lib/transfers/rows'

const ROW_HEIGHT = 56

// Only what failed, to pick from: one, some or all of it becomes one new transfer. Opened from
// the transfer's drawer (`TransferDetailsDrawer`), over it.
export default function TransferRetryDrawer({
    isOpen,
    onClose,
    transfer,
    detail,
    items,
}: {
    isOpen: boolean
    onClose: () => void
    transfer: TransferRow
    detail: TransferDetail
    /** What can be retried (`retryPlan`). */
    items: RetryItem[]
}) {
    const queryClient = useQueryClient()
    const allKeys = useMemo(() => items.map((item) => item.key), [items])
    // Everything starts selected: retrying all of it is the common case and is then one press.
    // A single file is "none", then that file.
    const [selected, setSelected] = useState<Set<string>>(() => new Set(allKeys))
    useEffect(() => {
        if (isOpen) setSelected(new Set(allKeys))
    }, [isOpen, allKeys])

    // The list is virtualized (a bad run fails a thousand files), so it is told its height.
    const listArea = useRef<HTMLDivElement>(null)
    const [listHeight, setListHeight] = useState(320)
    useEffect(() => {
        if (!isOpen || !listArea.current) return
        const observer = new ResizeObserver(([entry]) => setListHeight(entry.contentRect.height))
        observer.observe(listArea.current)
        return () => observer.disconnect()
    }, [isOpen])

    const retry = useMutation({
        mutationFn: () =>
            startRetry(
                transfer,
                items.filter((item) => selected.has(item.key)),
                detail
            ),
        onSuccess: async ({ jobid }) => {
            queryClient.invalidateQueries({ queryKey: ['transfers', 'list'] })
            onClose()
            await notify({ title: 'Retry started', body: `It is transfer #${jobid}.` })
        },
        onError: async (error) => {
            // Declining to reconnect a remote is an answer, not a failure to report.
            if (error instanceof UserCancelledError) return
            await message(error instanceof Error ? error.message : 'Unknown error occurred', {
                title: 'Could not start the retry',
                kind: 'error',
            })
        },
    })

    return (
        <Drawer isOpen={isOpen} onClose={onClose} placement="right" size="lg">
            <DrawerContent>
                {/* The header names the dialog, so it is the title and nothing else. */}
                <DrawerHeader>Retry failed</DrawerHeader>
                <DrawerBody className="flex flex-col gap-3 overflow-hidden">
                    <p className="text-sm text-default-500">
                        What you pick runs as one new transfer, with the settings this one had.
                    </p>

                    <div className="flex flex-row items-center justify-between gap-2">
                        <Checkbox
                            isSelected={selected.size === items.length}
                            isIndeterminate={selected.size > 0 && selected.size < items.length}
                            onValueChange={(all) => setSelected(new Set(all ? allKeys : []))}
                        >
                            Select all
                        </Checkbox>
                        <p className="text-sm tabular-nums text-default-500">
                            {selected.size} of {items.length} selected
                        </p>
                    </div>

                    <div ref={listArea} className="flex-1 min-h-0">
                        <Listbox
                            aria-label="Failed files"
                            items={items}
                            isVirtualized={true}
                            virtualization={{
                                maxListboxHeight: listHeight,
                                itemHeight: ROW_HEIGHT,
                            }}
                            selectionMode="multiple"
                            selectedKeys={selected}
                            onSelectionChange={(keys) =>
                                setSelected(
                                    new Set(keys === 'all' ? allKeys : (keys as Set<string>))
                                )
                            }
                            hideSelectedIcon={true}
                            classNames={{ base: 'p-0', list: 'gap-0' }}
                        >
                            {(item) => (
                                <ListboxItem
                                    key={item.key}
                                    textValue={item.label}
                                    // The tick is drawn from the row's own `data-selected`.
                                    // The list is virtualized and does not re-render its rows
                                    // when the selection changes, so a tick handed to a row
                                    // from this component's state goes stale at once.
                                    startContent={
                                        <span
                                            aria-hidden={true}
                                            className="flex items-center justify-center size-5 mx-1 shrink-0 rounded-md border-2 border-default-300 group-data-[selected=true]:bg-primary group-data-[selected=true]:border-primary"
                                        >
                                            <CheckIcon
                                                strokeWidth={3}
                                                className="hidden size-3.5 text-primary-foreground group-data-[selected=true]:block"
                                            />
                                        </span>
                                    }
                                    // A long path gives way from its folders, never from
                                    // the file's own name: that is what a row is picked by.
                                    title={<PathLabel path={item.label} />}
                                    description={
                                        <span title={item.error}>{errorReason(item.error)}</span>
                                    }
                                    classNames={{
                                        base: 'h-14 rounded-none border-b border-divider',
                                        // Bounded all the way down, or a long path widens the row instead of
                                        // giving way inside it.
                                        wrapper: 'min-w-0',
                                        title: 'w-full min-w-0 font-medium',
                                        description: 'truncate text-danger',
                                    }}
                                />
                            )}
                        </Listbox>
                    </div>
                </DrawerBody>
                <DrawerFooter>
                    <Button variant="light" onPress={onClose}>
                        Cancel
                    </Button>
                    <Button
                        color="primary"
                        isDisabled={selected.size === 0}
                        isLoading={retry.isPending}
                        startContent={
                            retry.isPending ? undefined : <RotateCcwIcon className="w-4 h-4" />
                        }
                        onPress={() => retry.mutate()}
                    >
                        Retry {selected.size} selected
                    </Button>
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
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
