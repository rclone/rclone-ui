import {
    Button,
    Checkbox,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
    Radio,
    RadioGroup,
    ScrollShadow,
} from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import { CopyIcon, MoveIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { onErrorDialog } from '@/lib/errors'
import { parsePath } from '@/lib/paths'
import { startCopy, startMove } from '@/lib/rclone/start'

import { FileIcon } from '@/components/navigator'
import type { Entry, SelectItem } from '@/components/navigator/types'

export default function OperationDialog({
    items,
    destination,
    onClose,
    onComplete,
    onJobStarted,
}: {
    items: SelectItem[] | null
    destination: string | null
    onClose: () => void
    onComplete?: (operation: 'copy' | 'move') => void
    onJobStarted?: (id: string) => void
}) {
    const [operation, setOperation] = useState<'copy' | 'move'>('copy')
    const [overwrite, setOverwrite] = useState(false)

    const copyMutation = useMutation({
        mutationFn: async () => {
            if (!items || !destination) throw new Error('Missing items or destination')

            // As dropped: the start asks rclone what each is.
            const sources = items.map((item) => item.path)

            const { id } = await startCopy(
                {
                    sources,
                    destination,
                    options: {
                        copy: overwrite ? {} : { ignore_existing: true },
                        config: {},
                        filter: {},
                    },
                },
                false,
                { tags: ['commander'] }
            )
            onJobStarted?.(id)
        },
        onSuccess: () => {
            onComplete?.('copy')
            onClose()
        },
        onError: onErrorDialog('Error', 'Copy operation failed'),
    })

    const moveMutation = useMutation({
        mutationFn: async () => {
            if (!items || !destination) throw new Error('Missing items or destination')

            const sources = items.map((item) => item.path)

            const { id } = await startMove(
                {
                    sources,
                    destination,
                    options: {
                        move: overwrite ? {} : { ignore_existing: true },
                        config: {},
                        filter: {},
                    },
                },
                false,
                { tags: ['commander'] }
            )
            onJobStarted?.(id)
        },
        onSuccess: () => {
            onComplete?.('move')
            onClose()
        },
        onError: onErrorDialog('Error', 'Move operation failed'),
    })

    const handleConfirm = useCallback(() => {
        if (operation === 'copy') {
            copyMutation.mutate()
        } else {
            moveMutation.mutate()
        }
    }, [operation, copyMutation, moveMutation])

    const isLoading = copyMutation.isPending || moveMutation.isPending
    const itemCount = items?.length ?? 0

    const formatPath = (path: string) => {
        const parsed = parsePath(path)
        if (parsed.kind === 'remote') {
            const fileName = parsed.path.split('/').pop() || parsed.path
            return { remote: parsed.name, fileName, isRemote: true }
        }
        const fileName = path.split('/').pop() || path
        return { remote: 'Local', fileName, isRemote: false }
    }

    const destinationInfo = destination ? formatPath(destination) : null

    return (
        <Modal
            isOpen={!!items && items.length > 0}
            onClose={onClose}
            size="lg"
            hideCloseButton={isLoading}
        >
            <ModalContent>
                <ModalHeader className="flex items-center gap-2">
                    {operation === 'copy' ? (
                        <CopyIcon className="size-5" />
                    ) : (
                        <MoveIcon className="size-5" />
                    )}
                    <span>
                        {operation === 'copy' ? 'Copy' : 'Move'} {itemCount} item
                        {itemCount !== 1 ? 's' : ''}
                    </span>
                </ModalHeader>
                <ModalBody>
                    <div className="space-y-4">
                        <RadioGroup
                            label="Operation"
                            value={operation}
                            onValueChange={(val) => setOperation(val as 'copy' | 'move')}
                            orientation="vertical"
                            isDisabled={isLoading}
                        >
                            <Radio value="copy" description="Keep original files">
                                <div className="flex items-center gap-2">
                                    <CopyIcon className="size-4" />
                                    Copy
                                </div>
                            </Radio>
                            <Radio value="move" description="Delete after transfer">
                                <div className="flex items-center gap-2">
                                    <MoveIcon className="size-4" />
                                    Move
                                </div>
                            </Radio>
                        </RadioGroup>

                        <div className="p-3 rounded-lg bg-default-100">
                            <p className="mb-2 text-sm font-medium text-default-600">
                                Destination:
                            </p>
                            <div className="flex items-center gap-2">
                                <span className="px-2 py-1 text-xs font-medium rounded bg-primary-100 text-primary-700">
                                    {destinationInfo?.remote}
                                </span>
                                <span className="text-sm truncate">
                                    {destinationInfo?.fileName || '/'}
                                </span>
                            </div>
                        </div>

                        {itemCount > 1 && (
                            <div>
                                <p className="mb-2 text-sm font-medium text-default-600">
                                    Items to transfer:
                                </p>
                                <ScrollShadow className="p-2 rounded-lg max-h-40 bg-default-50">
                                    <ul className="space-y-1">
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
                                                    className="flex items-center gap-2 text-sm"
                                                >
                                                    <FileIcon entry={mockEntry} size="sm" />
                                                    <span className="truncate">
                                                        {info.fileName}
                                                    </span>
                                                    {info.isRemote && (
                                                        <span className="px-1.5 py-0.5 text-xs rounded bg-default-200 text-default-600">
                                                            {info.remote}
                                                        </span>
                                                    )}
                                                </li>
                                            )
                                        })}
                                    </ul>
                                </ScrollShadow>
                            </div>
                        )}

                        <Checkbox
                            isSelected={overwrite}
                            onValueChange={setOverwrite}
                            isDisabled={isLoading}
                            size="sm"
                        >
                            Overwrite existing files
                        </Checkbox>
                    </div>
                </ModalBody>
                <ModalFooter>
                    <Button variant="flat" onPress={onClose} isDisabled={isLoading}>
                        Cancel
                    </Button>
                    <Button color="primary" onPress={handleConfirm} isLoading={isLoading}>
                        {operation === 'copy' ? 'Copy' : 'Move'}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    )
}
