import { Checkbox, cn } from '@heroui/react'
import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader } from '@heroui/react'
import { Button, Input } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { homeDir } from '@tauri-apps/api/path'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message, open } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import { FolderOpen } from 'lucide-react'
import { startTransition, useCallback, useEffect, useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import { useFlags } from '../../lib/hooks'
import { RCLONE_CONFIG_DEFAULTS } from '../../lib/rclone/constants'
import { AutomountSourceError, probeMountSource } from '../../lib/rclone/mount'
import { lockWindows, unlockWindows } from '../../lib/window'
import { type RemoteConfig, useHostStore } from '../../store/host'
import { usePersistedStore } from '../../store/persisted'
import OptionsSection from './OptionsSection'

const parseJson = <T,>(json: string) => {
    try {
        return { ok: true as const, value: JSON.parse(json) as T }
    } catch (error) {
        return { ok: false as const, error }
    }
}

export default function RemoteAutoMountDrawer({
    remoteName,
    onClose,
    isOpen,
}: {
    remoteName: string
    onClose: () => void
    isOpen: boolean
}) {
    const { globalFlags, filterFlags, configFlags, mountFlags, vfsFlags } = useFlags()

    const licenseValid = usePersistedStore((state) => state.licenseValid)
    const remoteConfigs = useHostStore((state) => state.remoteConfigs)
    const mergeRemoteConfig = useHostStore((state) => state.mergeRemoteConfig)

    const [buttonText, setButtonText] = useState('Save Changes')

    const [config, setConfig] = useState<RemoteConfig | null>(null)

    const [mountOnStartConfigOptionsJson, setMountOnStartConfigOptionsJson] = useState<string>('{}')
    const [mountOnStartFilterOptionsJson, setMountOnStartFilterOptionsJson] = useState<string>('{}')
    const [mountOnStartMountOptionsJson, setMountOnStartMountOptionsJson] = useState<string>('{}')
    const [mountOnStartVfsOptionsJson, setMountOnStartVfsOptionsJson] = useState<string>('{}')

    useEffect(() => {
        const remoteConfig = remoteConfigs[remoteName] || {}

        const mountOptionsJson = JSON.stringify(
            remoteConfig?.mountOnStart?.mountOptions || {},
            null,
            2
        )
        const savedVfsOptions = remoteConfig?.mountOnStart?.vfsOptions
        const vfsOptionsJson = JSON.stringify(
            savedVfsOptions && Object.keys(savedVfsOptions).length > 0
                ? savedVfsOptions
                : RCLONE_CONFIG_DEFAULTS.vfs,
            null,
            2
        )
        const filterOptionsJson = JSON.stringify(
            remoteConfig?.mountOnStart?.filterOptions || {},
            null,
            2
        )
        const savedConfigOptions = remoteConfig?.mountOnStart?.configOptions
        const configOptionsJson = JSON.stringify(
            savedConfigOptions && Object.keys(savedConfigOptions).length > 0
                ? savedConfigOptions
                : RCLONE_CONFIG_DEFAULTS.config,
            null,
            2
        )

        startTransition(() => {
            setConfig(remoteConfig)
            setMountOnStartMountOptionsJson(mountOptionsJson)
            setMountOnStartVfsOptionsJson(vfsOptionsJson)
            setMountOnStartFilterOptionsJson(filterOptionsJson)
            setMountOnStartConfigOptionsJson(configOptionsJson)
        })
    }, [remoteConfigs, remoteName])

    const updateMountOnStart = useCallback(
        (
            currentConfig: RemoteConfig['mountOnStart'] | null | undefined,
            updatedProps: Partial<RemoteConfig['mountOnStart']>
        ) => {
            return {
                ...(currentConfig || {
                    enabled: false,
                    remotePath: '',
                    mountPoint: '',
                    mountOptions: {},
                    vfsOptions: {},
                    filterOptions: {},
                    configOptions: {},
                }),
                ...updatedProps,
            }
        },
        []
    )

    const saveDefaultsMutation = useMutation({
        mutationFn: async () => {
            if (!config) {
                throw new Error('No config')
            }

            const newConfig = {
                ...config,
            }

            const parseOptionsOrThrow = <T,>(json: string, label: string) => {
                const result = parseJson<T>(json)
                if (!result.ok) {
                    throw new Error(`Could not update remote, error parsing ${label} options`)
                }
                return result.value
            }

            const mountOnStartConfigOptions = parseOptionsOrThrow<Record<string, unknown>>(
                mountOnStartConfigOptionsJson,
                'Config'
            )
            if (Object.keys(mountOnStartConfigOptions).length > 0) {
                newConfig.mountOnStart = updateMountOnStart(newConfig.mountOnStart, {
                    configOptions: mountOnStartConfigOptions,
                })
            }

            const mountOptions = parseOptionsOrThrow<Record<string, unknown>>(
                mountOnStartMountOptionsJson,
                'Mount'
            )
            if (Object.keys(mountOptions).length > 0) {
                newConfig.mountOnStart = updateMountOnStart(newConfig.mountOnStart, {
                    mountOptions: mountOptions,
                })
            }

            const filterOptions = parseOptionsOrThrow<Record<string, unknown>>(
                mountOnStartFilterOptionsJson,
                'Filter'
            )
            if (Object.keys(filterOptions).length > 0) {
                newConfig.mountOnStart = updateMountOnStart(newConfig.mountOnStart, {
                    filterOptions: filterOptions,
                })
            }

            const vfsOptions = parseOptionsOrThrow<Record<string, unknown>>(
                mountOnStartVfsOptionsJson,
                'VFS'
            )
            if (Object.keys(vfsOptions).length > 0) {
                newConfig.mountOnStart = updateMountOnStart(newConfig.mountOnStart, {
                    vfsOptions: vfsOptions,
                })
            }

            if (newConfig.mountOnStart?.enabled && newConfig.mountOnStart.remotePath) {
                try {
                    await probeMountSource(`${remoteName}:${newConfig.mountOnStart.remotePath}`)
                } catch (error) {
                    if (error instanceof AutomountSourceError) {
                        throw error
                    }
                    console.warn('[RemoteAutoMountDrawer] source probe inconclusive:', error)
                }
            }

            mergeRemoteConfig(remoteName, newConfig)
            return newConfig
        },
        onSuccess: async (newConfig) => {
            setConfig(newConfig)
            await new Promise((resolve) => setTimeout(resolve, 500))
            setButtonText('Saved')
            setTimeout(() => {
                setButtonText('Save Changes')
            }, 1200)
        },
        onError: onErrorDialog('Could not update remote', 'Unknown error occurred', {
            capture: false,
            log: ['Failed to update remote:'],
        }),
    })

    const setMountOnStart = useCallback(
        (updatedProps: Partial<RemoteConfig['mountOnStart']>) => {
            setConfig((prev) => ({
                ...prev,
                mountOnStart: updateMountOnStart(prev?.mountOnStart, updatedProps),
            }))
        },
        [updateMountOnStart]
    )

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
                        <DrawerHeader className="flex flex-col gap-1">Auto Mount</DrawerHeader>
                        <DrawerBody>
                            <div className="flex flex-col gap-4">
                                <Input
                                    placeholder="Default Remote Path (starting with bucket name: bucket/path/to/folder)"
                                    type="text"
                                    value={config?.mountOnStart?.remotePath || ''}
                                    size="lg"
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                    onValueChange={(value) => {
                                        setMountOnStart({ remotePath: value })
                                    }}
                                />

                                <Input
                                    placeholder="Default Mount Point"
                                    type="text"
                                    value={config?.mountOnStart?.mountPoint || ''}
                                    size="lg"
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                    startContent={
                                        <Button
                                            onPress={async () => {
                                                try {
                                                    await lockWindows()
                                                    await getCurrentWindow().setFocus()
                                                    const selected = await open({
                                                        directory: true,
                                                        multiple: false,
                                                        defaultPath: await homeDir(),
                                                        title: 'Select a mount point',
                                                    })
                                                    await unlockWindows()
                                                    if (selected) {
                                                        setMountOnStart({
                                                            mountPoint: selected,
                                                        })
                                                    }
                                                } catch (err) {
                                                    console.error(
                                                        'Failed to open folder picker:',
                                                        err
                                                    )
                                                    await message('Failed to open folder picker', {
                                                        title: 'Error',
                                                        kind: 'error',
                                                    })
                                                }
                                            }}
                                            isIconOnly={true}
                                            data-focus-visible="false"
                                            size="sm"
                                        >
                                            <FolderOpen className="w-4 h-4" />
                                        </Button>
                                    }
                                    endContent={
                                        <Checkbox
                                            isSelected={config?.mountOnStart?.enabled || false}
                                            onValueChange={async (value) => {
                                                if (!licenseValid) {
                                                    await message(
                                                        'Community version does not support mount on startup.',
                                                        {
                                                            title: 'Missing license',
                                                            kind: 'error',
                                                        }
                                                    )
                                                    return
                                                }

                                                if (
                                                    !config?.mountOnStart?.mountPoint ||
                                                    !config?.mountOnStart?.remotePath
                                                ) {
                                                    await message(
                                                        'Please set a default mount point and remote path before enabling this option',
                                                        {
                                                            title: 'Missing Information',
                                                            kind: 'error',
                                                        }
                                                    )
                                                    return
                                                }

                                                setMountOnStart({ enabled: value })
                                            }}
                                            size="sm"
                                            data-focus-visible="false"
                                            className="h-full m-0 min-w-fit"
                                        >
                                            Mount on startup
                                        </Checkbox>
                                    }
                                    onValueChange={(value) => {
                                        setMountOnStart({
                                            mountPoint: value,
                                        })
                                    }}
                                />

                                <OptionsSection
                                    label="Mount Options"
                                    optionsJson={mountOnStartMountOptionsJson}
                                    setOptionsJson={setMountOnStartMountOptionsJson}
                                    globalOptions={globalFlags?.mount || {}}
                                    availableOptions={mountFlags || []}
                                />

                                <OptionsSection
                                    label="VFS Options"
                                    optionsJson={mountOnStartVfsOptionsJson}
                                    setOptionsJson={setMountOnStartVfsOptionsJson}
                                    globalOptions={globalFlags?.vfs || {}}
                                    availableOptions={vfsFlags || []}
                                />

                                <OptionsSection
                                    label="Config Options"
                                    optionsJson={mountOnStartConfigOptionsJson}
                                    setOptionsJson={setMountOnStartConfigOptionsJson}
                                    globalOptions={globalFlags?.main || {}}
                                    availableOptions={configFlags || []}
                                />

                                <OptionsSection
                                    label="Filter Options"
                                    optionsJson={mountOnStartFilterOptionsJson}
                                    setOptionsJson={setMountOnStartFilterOptionsJson}
                                    globalOptions={globalFlags?.filter || {}}
                                    availableOptions={filterFlags || []}
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
                                isDisabled={saveDefaultsMutation.isPending}
                                onPress={() => {
                                    setTimeout(() => saveDefaultsMutation.mutate(), 100)
                                }}
                                data-focus-visible="false"
                            >
                                {buttonText}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
