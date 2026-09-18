import {
    Button,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
} from '@heroui/react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { UserCancelledError, formatErrorMessage } from '../../lib/errors'
import { reconnectRemote } from '../../lib/rclone/api'

export interface StaleRemote {
    name: string
    type: string
}

type RowState = { status: 'idle' | 'working' | 'done' } | { status: 'failed'; message: string }

/**
 * The remotes whose sign-in has to be done again, in one place. Each row runs the same flow the
 * prompt does, so the sign-in dialog opens over this drawer and the row settles when it closes.
 */
export default function RemotesReconnectDrawer({
    isOpen,
    onClose,
    remotes,
}: {
    isOpen: boolean
    onClose: () => void
    remotes: StaleRemote[]
}) {
    const queryClient = useQueryClient()
    const [rows, setRows] = useState<Record<string, RowState>>({})
    // The list is taken when the drawer opens and then held. Reconnecting one drops it from the
    // count that produced this list, and a row that disappeared at the moment it succeeded would
    // take its own confirmation with it. Opening again starts from what is wrong now.
    const [shown, setShown] = useState<StaleRemote[]>(remotes)
    // biome-ignore lint/correctness/useExhaustiveDependencies: `remotes` is read when the drawer opens, not followed while it is open — holding the list is the point
    useEffect(() => {
        if (!isOpen) return
        setShown(remotes)
        setRows({})
    }, [isOpen])
    const stateOf = (name: string): RowState => rows[name] ?? { status: 'idle' }

    const reconnect = async (name: string) => {
        setRows((prev) => ({ ...prev, [name]: { status: 'working' } }))
        try {
            await reconnectRemote(name)
            setRows((prev) => ({ ...prev, [name]: { status: 'done' } }))
            // The badge counted this one and the file panel cached its failure; both re-ask now
            // rather than waiting out the day-long cache.
            queryClient.invalidateQueries({ queryKey: ['remote', name] })
            queryClient.invalidateQueries({ queryKey: ['dashboard', 'remotes'] })
        } catch (error) {
            // Stopping the sign-in is an answer, not a failure: the row goes back as it was.
            if (error instanceof UserCancelledError) {
                setRows((prev) => ({ ...prev, [name]: { status: 'idle' } }))
                return
            }
            setRows((prev) => ({
                ...prev,
                [name]: { status: 'failed', message: formatErrorMessage(error) },
            }))
        }
    }

    return (
        <Drawer
            isOpen={isOpen}
            onClose={onClose}
            placement="right"
            size="md"
            aria-label="Remotes needing reconnection"
        >
            <DrawerContent>
                <DrawerHeader className="flex flex-col gap-1">
                    <span>Remotes needing reconnection</span>
                    <span className="text-sm font-normal text-default-500">
                        Their sign-in has expired and cannot be renewed on its own. Reconnecting
                        opens the provider's sign-in again; nothing else about the remote changes.
                    </span>
                </DrawerHeader>
                <DrawerBody>
                    <ul className="flex flex-col gap-2">
                        {shown.map((remote) => {
                            const row = stateOf(remote.name)
                            return (
                                <li
                                    key={remote.name}
                                    className="flex items-center gap-3 p-3 rounded-large bg-default-100 dark:bg-white/5"
                                >
                                    <img
                                        src={`/icons/backends/${remote.type}.png`}
                                        alt=""
                                        className="object-contain size-6 shrink-0"
                                        onError={(event) => {
                                            event.currentTarget.style.visibility = 'hidden'
                                        }}
                                    />
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-sm font-medium truncate">
                                            {remote.name}
                                        </span>
                                        <span className="text-xs truncate text-default-500">
                                            {row.status === 'failed' ? row.message : remote.type}
                                        </span>
                                    </div>
                                    <div className="ml-auto shrink-0">
                                        {row.status === 'done' ? (
                                            <span className="flex items-center gap-1 text-sm text-success">
                                                <CheckIcon className="size-4" />
                                                Reconnected
                                            </span>
                                        ) : (
                                            <Button
                                                size="sm"
                                                color="primary"
                                                variant="flat"
                                                isLoading={row.status === 'working'}
                                                onPress={() => reconnect(remote.name)}
                                            >
                                                {row.status === 'failed'
                                                    ? 'Try again'
                                                    : 'Reconnect'}
                                            </Button>
                                        )}
                                    </div>
                                </li>
                            )
                        })}
                    </ul>
                </DrawerBody>
                <DrawerFooter>
                    <Button variant="light" onPress={onClose}>
                        Close
                    </Button>
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
    )
}
