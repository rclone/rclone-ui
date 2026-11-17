import { Drawer, DrawerBody, DrawerFooter, DrawerHeader, cn } from '@heroui/react'
import { Autocomplete, AutocompleteItem, Button, DrawerContent, Input } from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { message } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import { ChevronDown, ChevronUp, RefreshCcwIcon } from 'lucide-react'
import { type Key, startTransition, useCallback, useMemo, useState } from 'react'
import { UserCancelledError } from '../../lib/errors'
import rclone from '../../lib/rclone/client'
import { createRemoteInteractive } from '../../lib/rclone/interactive'
import { INTERACTIVE_CONFIG_TYPES, OVERRIDES, OWN_OAUTH_TYPES } from '../../lib/rclone/overrides'
import RemoteField from './RemoteField'

export default function RemoteCreateDrawer({
    isOpen,
    onClose,
}: { isOpen: boolean; onClose: () => void }) {
    const queryClient = useQueryClient()
    const [config, setConfig] = useState<Record<string, any>>({})
    const [showMoreOptions, setShowMoreOptions] = useState(false)

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
            .filter((b) => !['uptobox', 'tardigrade'].includes(b.Name))
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
        () => (config.type ? sortedEnrichedBackends.find((b) => b.Name === config.type) : null),
        [config.type, sortedEnrichedBackends]
    )

    const currentBackendFields = useMemo(
        () =>
            currentBackend
                ? currentBackend.Options.filter((opt) => {
                      if (!opt.Provider) return true
                      if (opt.Provider.includes(config.provider) && !opt.Provider.startsWith('!'))
                          return true
                      if (
                          config.type === 's3' &&
                          config.provider === 'Other' &&
                          opt.Provider.includes('!')
                      )
                          return true
                      return false
                  }) || []
                : [],
        [currentBackend, config.provider, config.type]
    )

    // Google Drive / Google Photos require the user's own OAuth credentials (rclone is retiring its
    // shared client-id). Block creation until they're supplied.
    const missingCredentials = useMemo(
        () =>
            OWN_OAUTH_TYPES.includes(config.type)
                ? ['client_id', 'client_secret'].filter((f) => !(config[f] || '').trim())
                : [],
        [config]
    )

    const createRemoteMutation = useMutation({
        mutationFn: async ({
            name,
            type,
            parameters,
        }: { name: string; type: string; parameters: Record<string, any> }) => {
            console.log('[RemoteCreateDrawer] newRemoteConfig', name, type, parameters)

            if (INTERACTIVE_CONFIG_TYPES.includes(type)) {
                return createRemoteInteractive({ name, type, parameters })
            }

            await rclone('/config/create', {
                params: {
                    query: {
                        name,
                        type,
                        parameters: JSON.stringify(parameters),
                        opt: JSON.stringify({ obscure: true }),
                    },
                },
            })

            return name
        },
        onSuccess: async (name) => {
            queryClient.setQueryData(['remotes', 'list', 'all'], (old: string[] | undefined) => [
                ...(old ?? []),
                name,
            ])
            onClose()
            setConfig({})
            setShowMoreOptions(false)
        },
        onError: async (error) => {
            console.error('Failed to create remote:', error)

            if (error instanceof UserCancelledError) {
                return
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

            if (errorMessage.includes('address already in use')) {
                await message(
                    'Rclone Oauth Client is stuck, please restart the UI to add new remotes',
                    {
                        title: 'Busy',
                        kind: 'error',
                    }
                )
                return
            }

            await message(errorMessage, {
                title: 'Could not create remote',
                kind: 'error',
            })
        },
    })

    const handleTypeChange = useCallback((key: Key | null) => {
        const newType = key ? String(key) : undefined

        // preserve name when resetting type
        setConfig((prev) => ({ name: prev.name, type: newType }))
    }, [])

    return (
        <Drawer
            isOpen={isOpen}
            placement={'bottom'}
            size="full"
            onClose={() => {
                startTransition(() => {
                    setConfig({})
                    setShowMoreOptions(false)
                    createRemoteMutation.reset()
                })
                onClose()
            }}
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
                        <DrawerHeader className="flex flex-row justify-between gap-1">
                            <span>Create Remote</span>
                            <Button
                                size="sm"
                                variant="faded"
                                color="danger"
                                startContent={<RefreshCcwIcon className="w-3 h-3" />}
                                onPress={() => setConfig({})}
                                data-focus-visible="false"
                                className="gap-2"
                            >
                                Reset
                            </Button>
                        </DrawerHeader>
                        <DrawerBody id="create-form-body">
                            <div className="flex flex-col gap-4">
                                <Input
                                    id="remote-name"
                                    name="name"
                                    label="name"
                                    labelPlacement="outside"
                                    placeholder="Remote name (for your reference)"
                                    value={config.name || ''}
                                    onValueChange={(value) => setConfig({ ...config, name: value })}
                                    isRequired={true}
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                />

                                <Autocomplete
                                    id="remote-type"
                                    name="type"
                                    label="type"
                                    labelPlacement="outside"
                                    placeholder="Select type or search"
                                    selectedKey={config.type ?? null}
                                    onSelectionChange={handleTypeChange}
                                    isRequired={true}
                                    itemHeight={42}
                                    autoCapitalize="off"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                >
                                    {sortedEnrichedBackends.map((backend) => (
                                        <AutocompleteItem
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
                                        </AutocompleteItem>
                                    ))}
                                </Autocomplete>

                                {/* Normal Fields */}
                                {currentBackendFields
                                    .filter((opt) => !opt.Advanced)
                                    .map((opt) => (
                                        <RemoteField
                                            key={opt.Name}
                                            option={opt}
                                            config={config}
                                            setConfig={setConfig}
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
                                                            config={config}
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
                                Cancel
                            </Button>
                            <Button
                                color="primary"
                                isLoading={createRemoteMutation.isPending}
                                isDisabled={missingCredentials.length > 0}
                                data-focus-visible="false"
                                onPress={() => {
                                    setTimeout(() => {
                                        const { name, type, ...parameters } = config
                                        createRemoteMutation.mutate({
                                            name,
                                            type,
                                            parameters,
                                        })
                                    }, 10)
                                }}
                            >
                                {createRemoteMutation.isPending ? 'Creating...' : 'Create Remote'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
