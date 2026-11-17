import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader, cn } from '@heroui/react'
import { Button, Select, SelectItem } from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { platform } from '@tauri-apps/plugin-os'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import { useRemoteConfig } from '../../lib/hooks'
import queryClient from '../../lib/query'
import rclone from '../../lib/rclone/client'
import { INTERACTIVE_CONFIG_TYPES, OVERRIDES, OWN_OAUTH_TYPES } from '../../lib/rclone/overrides'
import RemoteField from './RemoteField'

export default function RemoteEditDrawer({
    remoteName,
    onClose,
    isOpen,
}: {
    remoteName: string
    onClose: () => void
    isOpen: boolean
}) {
    const [config, setConfig] = useState<Record<string, any>>({})
    const [showMoreOptions, setShowMoreOptions] = useState(false)

    const remoteConfigQuery = useRemoteConfig(remoteName)

    const remoteConfig = useMemo(() => remoteConfigQuery.data, [remoteConfigQuery.data])

    const backendsQuery = useQuery({
        queryKey: ['backends'],
        queryFn: async () => {
            const backends = await rclone('/config/providers')
            return backends.providers
        },
    })

    const sortedEnrichedBackends = useMemo(() => {
        const backends = backendsQuery.data ?? []

        return backends
            .filter((b) => b.Name !== 'tardigrade')
            .map((backend) => {
                const override = OVERRIDES[backend.Name as keyof typeof OVERRIDES]
                return {
                    ...backend,
                    Description: override?.Description || backend.Description,
                }
            })
            .sort((a, b) => {
                return a.Name.localeCompare(b.Name)
            })
    }, [backendsQuery.data])

    const currentBackend = useMemo(
        () =>
            remoteConfigQuery.data
                ? sortedEnrichedBackends.find((b) => b.Name === remoteConfigQuery.data?.type)
                : null,
        [remoteConfigQuery.data, sortedEnrichedBackends]
    )

    const currentBackendFields = useMemo(
        () =>
            currentBackend && remoteConfig
                ? currentBackend.Options.filter((opt) => {
                      if (!opt.Provider) return true
                      if (
                          remoteConfig.provider &&
                          opt.Provider.includes(remoteConfig.provider) &&
                          !opt.Provider.startsWith('!')
                      )
                          return true
                      if (
                          remoteConfig.type === 's3' &&
                          remoteConfig.provider === 'Other' &&
                          opt.Provider.includes('!')
                      )
                          return true
                      return false
                  }) || []
                : [],
        [currentBackend, remoteConfig]
    )

    // Google Drive / Google Photos require the user's own OAuth credentials (rclone is retiring its
    // shared client-id). Check the effective config (saved values + pending edits) so a legacy
    // remote missing credentials can't be saved until they're added, while a remote that already
    // has them stays editable.
    const missingCredentials = useMemo(() => {
        const effective = { ...remoteConfig, ...config }
        return OWN_OAUTH_TYPES.includes(effective.type ?? '')
            ? ['client_id', 'client_secret'].filter((f) => !(effective[f] || '').trim())
            : []
    }, [remoteConfig, config])

    const updateRemoteMutation = useMutation({
        mutationFn: async (updatedRemoteConfig: Record<string, any>) => {
            console.log('[RemoteEditDrawer] updatedRemoteConfig', updatedRemoteConfig)

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

            return updatedRemoteConfig
        },
        onSuccess: async (updatedRemoteConfig) => {
            // Best-effort cache clear; a failure here must not reject onSuccess and leave the
            // drawer stranded open after an otherwise-successful save.
            await rclone('/fscache/clear').catch(() => null)
            queryClient.setQueryData(
                ['remote', remoteName, 'config'],
                (old?: typeof remoteConfig) => ({
                    ...(old || {}),
                    ...updatedRemoteConfig,
                })
            )
            // Capabilities can change with the config (e.g. s3 provider, webdav vendor, a wrapped
            // backend's target), so drop the cached fsinfo probe and let consumers re-fetch.
            queryClient.invalidateQueries({ queryKey: ['remote', remoteName, 'fsinfo'] })
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
                    platform() === 'macos' && 'pt-5'
                )}
            >
                {(close) => (
                    <>
                        <DrawerHeader className="flex flex-col gap-1">
                            Edit {remoteName}
                        </DrawerHeader>
                        <DrawerBody>
                            <div className="flex flex-col gap-4">
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
                                                    src={`/icons/backends/${backend.Prefix}.png`}
                                                    className="object-contain w-8 h-8"
                                                    alt={backend.Name}
                                                />
                                            }
                                        >
                                            {backend.Description || backend.Name}
                                        </SelectItem>
                                    ))}
                                </Select>

                                {/* Normal Fields */}
                                {currentBackendFields
                                    .filter((opt) => !opt.Advanced)
                                    .map((opt) => (
                                        <RemoteField
                                            key={opt.Name}
                                            option={opt}
                                            config={remoteConfig || {}}
                                            setConfig={setConfig}
                                            isDisabled={opt.Name === 'provider'}
                                        />
                                    ))}

                                {/* Advanced Fields */}
                                {currentBackendFields.some((opt) => opt.Advanced) && (
                                    <div className="pt-4">
                                        <button
                                            type="button"
                                            onClick={() => setShowMoreOptions((prev) => !prev)}
                                            className="flex items-center space-x-2 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                                        >
                                            {showMoreOptions ? (
                                                <ChevronUp className="w-4 h-4" />
                                            ) : (
                                                <ChevronDown className="w-4 h-4" />
                                            )}
                                            <span>More Options</span>
                                        </button>

                                        {showMoreOptions && (
                                            <div className="flex flex-col gap-4 pt-4 mt-4">
                                                {currentBackendFields
                                                    .filter((opt) => opt.Advanced)
                                                    .map((opt) => (
                                                        <RemoteField
                                                            key={opt.Name}
                                                            option={opt}
                                                            config={remoteConfig || {}}
                                                            setConfig={setConfig}
                                                        />
                                                    ))}
                                            </div>
                                        )}
                                    </div>
                                )}
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
                                    updateRemoteMutation.isPending || missingCredentials.length > 0
                                }
                                data-focus-visible="false"
                                onPress={() => {
                                    updateRemoteMutation.mutate(config)
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
