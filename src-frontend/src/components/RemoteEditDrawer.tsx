import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader, cn } from '@heroui/react'
import { Button, Input, Select, SelectItem } from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { useMemo, useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import { useRemoteConfig } from '../../lib/hooks'
import queryClient from '../../lib/query'
import rclone from '../../lib/rclone/client'
import { INTERACTIVE_CONFIG_TYPES } from '../../lib/rclone/overrides'
import { checkRemoteName, renameRemote } from '../../lib/rclone/rename'
import RemoteFields from './remote/RemoteFields'
import { useRemoteForm } from './remote/useRemoteForm'
import { isNativeMac } from '../../lib/api/os'

// Backends the edit drawer never lists, and the saved fields it keeps read-only.
const EDIT_EXCLUDES = ['tardigrade'] as const
const EDIT_LOCKED_FIELDS = ['provider'] as const

export default function RemoteEditDrawer({
    remoteName,
    onClose,
    isOpen,
}: {
    remoteName: string
    onClose: () => void
    isOpen: boolean
}) {
    const [name, setName] = useState(remoteName)
    const [showMoreOptions, setShowMoreOptions] = useState(false)

    // The other remotes' names, so a clash is caught while typing (the Sidebar's query, shared).
    const remotesQuery = useQuery({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => await rclone('/config/listremotes').then((r) => r?.remotes),
        staleTime: 1000 * 60,
    })
    const renaming = name !== remoteName
    const nameError = renaming ? checkRemoteName(name, remotesQuery.data ?? []) : undefined

    const remoteConfigQuery = useRemoteConfig(remoteName)

    const remoteConfig = useMemo(() => remoteConfigQuery.data, [remoteConfigQuery.data])

    const form = useRemoteForm({ saved: remoteConfig, exclude: EDIT_EXCLUDES })
    const {
        pending: config,
        setPending: setConfig,
        backends: sortedEnrichedBackends,
        fields,
        missingCredentials,
    } = form

    const updateRemoteMutation = useMutation({
        mutationFn: async ({
            updates: updatedRemoteConfig,
            name,
        }: { updates: Record<string, any>; name: string }) => {
            console.log('[RemoteEditDrawer] updatedRemoteConfig', updatedRemoteConfig)

            // The parameters are saved under the current name first, so a rename copies them.
            if (Object.keys(updatedRemoteConfig).length > 0) {
                const isInteractiveType = INTERACTIVE_CONFIG_TYPES.includes(
                    remoteConfig?.type ?? ''
                )
                await rclone('/config/update', {
                    params: {
                        query: {
                            name: remoteName,
                            parameters: JSON.stringify(updatedRemoteConfig),
                            opt: JSON.stringify(
                                isInteractiveType
                                    ? { obscure: true, nonInteractive: true }
                                    : { obscure: true }
                            ),
                        },
                    },
                })
            }

            if (name !== remoteName) {
                const problem = checkRemoteName(name, remotesQuery.data ?? [])
                if (problem) throw new Error(problem)
                await renameRemote(remoteName, name)
            }

            return { updates: updatedRemoteConfig, name }
        },
        onSuccess: async ({ updates: updatedRemoteConfig, name }) => {
            // Best-effort cache clear; a failure here must not reject onSuccess and leave the
            // drawer stranded open after an otherwise-successful save.
            await rclone('/fscache/clear').catch(() => null)
            if (name !== remoteName) {
                // The old name's entries are gone with the remote; the new one starts warm.
                queryClient.removeQueries({ queryKey: ['remote', remoteName] })
                queryClient.setQueryData(['remote', name, 'config'], {
                    ...(remoteConfig || {}),
                    ...updatedRemoteConfig,
                })
            } else {
                queryClient.setQueryData(
                    ['remote', remoteName, 'config'],
                    (old?: typeof remoteConfig) => ({
                        ...(old || {}),
                        ...updatedRemoteConfig,
                    })
                )
                // Capabilities can change with the config (e.g. s3 provider, webdav vendor, a
                // wrapped backend's target), so drop the cached fsinfo probe and let consumers
                // re-fetch.
                queryClient.invalidateQueries({ queryKey: ['remote', remoteName, 'fsinfo'] })
            }
            onClose()
        },
        onError: onErrorDialog('Could not update remote', 'Unknown error occurred', {
            capture: false,
            log: ['Failed to update remote:'],
        }),
    })

    // if (!remoteConfig) return null

    return (
        <Drawer
            isOpen={isOpen}
            placement={'bottom'}
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent
                className={cn(
                    'bg-content1/80 backdrop-blur-md dark:bg-content1/90',
                    isNativeMac && 'pt-5'
                )}
            >
                {(close) => (
                    <>
                        <DrawerHeader className="flex flex-col gap-1">
                            Edit {remoteName}
                        </DrawerHeader>
                        <DrawerBody>
                            <div className="flex flex-col gap-4">
                                <Input
                                    id="edit-remote-name"
                                    name="name"
                                    label="Name"
                                    labelPlacement="outside"
                                    placeholder="Remote name (for your reference)"
                                    value={name}
                                    onValueChange={setName}
                                    isInvalid={!!nameError}
                                    errorMessage={nameError}
                                    description={
                                        renaming && !nameError
                                            ? 'Saving renames the remote. Its schedules, favorites and mount settings follow; anything mounted or served under the old name keeps running until stopped.'
                                            : undefined
                                    }
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                />
                                <Select
                                    id="edit-remote-type"
                                    name="type"
                                    label="type"
                                    labelPlacement="outside"
                                    selectionMode="single"
                                    placeholder="Select Type"
                                    selectedKeys={remoteConfig?.type ? [remoteConfig.type] : []}
                                    isDisabled={true}
                                    itemHeight={42}
                                >
                                    {sortedEnrichedBackends.map((backend) => (
                                        <SelectItem
                                            key={backend.Name}
                                            startContent={
                                                <img
                                                    src={`/icons/backends/${backend.Name}.png`}
                                                    className="object-contain w-8 h-8"
                                                    alt={backend.Name}
                                                />
                                            }
                                        >
                                            {backend.Description || backend.Name}
                                        </SelectItem>
                                    ))}
                                </Select>

                                <RemoteFields
                                    fields={fields}
                                    values={remoteConfig || {}}
                                    setValues={setConfig}
                                    disabledFields={EDIT_LOCKED_FIELDS}
                                    showMore={showMoreOptions}
                                    onToggleMore={() => setShowMoreOptions((prev) => !prev)}
                                />
                            </div>
                        </DrawerBody>
                        <DrawerFooter>
                            <Button
                                color="danger"
                                variant="light"
                                onPress={close}
                                data-focus-visible="false"
                            >
                                Close
                            </Button>
                            <Button
                                color="primary"
                                isDisabled={
                                    updateRemoteMutation.isPending ||
                                    missingCredentials.length > 0 ||
                                    !!nameError
                                }
                                data-focus-visible="false"
                                onPress={() => {
                                    updateRemoteMutation.mutate({ updates: config, name })
                                }}
                            >
                                {updateRemoteMutation.isPending ? 'Saving...' : 'Save Changes'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
