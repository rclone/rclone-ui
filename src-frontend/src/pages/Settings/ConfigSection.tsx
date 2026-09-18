import {
    Avatar,
    Button,
    Card,
    CardBody,
    Chip,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import {
    DownloadIcon,
    FolderOpenIcon,
    ImportIcon,
    LockIcon,
    PencilIcon,
    PlusIcon,
    Trash2Icon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { onErrorDialog } from '../../../lib/errors'
import { removeConfigPassword, setConfigPassword } from '../../../lib/rclone/api'
import { promptForConfigPassword, restartActiveRclone } from '../../../lib/rclone/cli'
import rclone from '../../../lib/rclone/client'
import { getConfigPath, resolveConfigFilePath } from '../../../lib/rclone/common'
import { reconcileConfigSync } from '../../../lib/rclone/versions'
import { selectActiveConfigFile, useHostStore } from '../../../store/host'
import type { ConfigFile } from '../../../types/config'
import ConfigCreateDrawer from '../../components/ConfigCreateDrawer'
import ConfigEditDrawer from '../../components/ConfigEditDrawer'
import ConfigSyncDrawer from '../../components/ConfigSyncDrawer'
import BaseSection from './BaseSection'
import { ask, message, pickPath } from '../../../lib/api/dialog'
import { readFile, removeDir, writeFile } from '../../../lib/rclone/daemon-fs'
import { platform } from '../../../lib/api/os'
import { sep } from '../../../lib/api/paths'
import { rpc } from '../../../lib/api/rpc'
import { revealItem } from '../../../lib/api/shell'

export default function ConfigSection() {
    const configFiles = useHostStore((state) => state.configFiles)
    const activeConfigFile = useHostStore(selectActiveConfigFile)

    const queryClient = useQueryClient()

    const [isCreateDrawerOpen, setIsCreateDrawerOpen] = useState(false)
    const [isSyncDrawerOpen, setIsSyncDrawerOpen] = useState(false)
    const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false)
    const [focusedConfigId, setFocusedConfigId] = useState<string | null>(null)

    const switchConfigMutation = useMutation({
        mutationFn: async (configFile: ConfigFile) => {
            if (configFile.id === activeConfigFile?.id) {
                return
            }

            const confirmed = await ask(`Switch to config ${configFile.label}?`, {
                title: 'Switch Config',
                kind: 'info',
                okLabel: 'OK',
                cancelLabel: 'Cancel',
            })

            if (!confirmed) {
                return
            }

            const shouldRestartRclone =
                Boolean(activeConfigFile?.isEncrypted) || Boolean(configFile.isEncrypted)
            const prevActiveId = activeConfigFile?.id ?? 'default'

            const reconcileSyncLink = async () => {
                const sync = await reconcileConfigSync()
                if (sync.error && useHostStore.getState().syncConfigToSystem) {
                    await message(
                        `Switched config, but the terminal config sync link could not be updated:\n${sync.error}`,
                        { title: 'Config sync', kind: 'warning', okLabel: 'OK' }
                    )
                }
            }

            if (shouldRestartRclone) {
                // Encrypted path: the daemon re-inits from the restart snapshot, which reads the
                // store — so update the store and re-point the sync link (capturing any relocated
                // defaultConfigPath) BEFORE emitting the restart. If the emit itself fails, roll the
                // store + link back so all of store/terminal/daemon stay on the previous config.
                useHostStore.getState().setActiveConfigFile(configFile.id!)
                await reconcileSyncLink()
                if (!(await restartActiveRclone())) {
                    useHostStore.getState().setActiveConfigFile(prevActiveId)
                    await reconcileConfigSync()
                    throw new Error('Could not restart rclone to apply the config switch.')
                }
            } else {
                // Live path: resolve + validate the target's real path (honoring an external `sync`
                // folder) and move the RUNNING daemon FIRST — the throwable step. Only once it
                // succeeds do we commit the store + re-point the sync link, so a /config/setpath
                // failure leaves store, terminal, and daemon all on the previous config (no
                // divergence, nothing to roll back).
                const setpathTarget = await resolveConfigFilePath(configFile, { validate: true })
                await rclone('/config/setpath', {
                    params: {
                        query: {
                            'path': setpathTarget,
                        },
                    },
                })
                useHostStore.getState().setActiveConfigFile(configFile.id!)
                await reconcileSyncLink()
            }
            await queryClient.cancelQueries()
            await queryClient.resetQueries()
        },
        onError: onErrorDialog('Switch Config', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[switchConfig] failed to switch config'],
        }),
    })

    const locateConfigMutation = useMutation({
        mutationFn: async (id: string) => {
            const configPath = await getConfigPath({ id: id, validate: true })
            await revealItem(configPath)
        },
        onError: onErrorDialog('Failed to locate config', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[locateConfig] failed to locate config'],
        }),
    })

    const exportConfigMutation = useMutation({
        mutationFn: async ({ id, label }: { id: string; label: string }) => {
            const configPath = await getConfigPath({ id: id, validate: true })
            const text = await readFile(configPath)

            const selectedPath = await pickPath({
                title: `Select a directory to export "${label}"`,
                multiple: false,
                directory: true,
            })

            if (!selectedPath) {
                return
            }

            console.log('[exportConfig] selectedPath', selectedPath)

            // allow spaces, dashes, and underscores
            const exportPath = `${selectedPath}${sep}${label.replace(/[^a-zA-Z0-9\s\-_]/g, '')}.conf`

            await writeFile(exportPath, text)
        },
        onError: onErrorDialog('Failed to export config', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[exportConfig] failed to export config'],
        }),
    })

    const removePasswordMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!activeConfigFile?.id || id !== activeConfigFile.id) {
                throw new Error('Only the active configuration can be decrypted.')
            }

            if (!activeConfigFile.isEncrypted) {
                throw new Error('Encryption is already disabled for the active configuration.')
            }

            const confirmed = await ask(
                'This will remove the encryption password from the config.',
                {
                    title: 'Disable Encryption?',
                    kind: 'warning',
                    okLabel: 'Disable',
                    cancelLabel: 'Cancel',
                }
            )

            if (!confirmed) {
                return
            }

            await removeConfigPassword()
        },
        onError: onErrorDialog('Config Encryption', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[removePassword] failed to remove password'],
        }),
    })

    const setPasswordMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!activeConfigFile?.id || id !== activeConfigFile.id) {
                throw new Error('Only the active configuration password can be set.')
            }

            const password = await promptForConfigPassword(
                `Enter a new password for "${activeConfigFile.label}".`
            )

            if (!password) {
                return
            }

            await setConfigPassword({
                password,
                persist: Boolean(activeConfigFile.pass),
            })
        },
        onError: onErrorDialog('Config Encryption', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[setPassword] failed to set password'],
        }),
    })

    const savePasswordMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!activeConfigFile?.id || id !== activeConfigFile.id) {
                throw new Error('Only the active configuration password can be saved.')
            }

            if (!activeConfigFile.isEncrypted) {
                throw new Error('Enable encryption before saving the password.')
            }

            if (activeConfigFile.pass) {
                throw new Error('A password is already saved for this configuration.')
            }

            if (activeConfigFile.passCommand) {
                throw new Error('A password command is already saved for this configuration.')
            }

            const password = await promptForConfigPassword(
                `Enter the current password for "${activeConfigFile.label}" to save it.`
            )

            if (!password) {
                return
            }

            useHostStore.getState().updateConfigFile(id, {
                pass: password,
                passCommand: undefined,
            })
            await message('The password has been saved for this configuration.', {
                title: 'Config Password',
                kind: 'info',
                okLabel: 'OK',
            })
        },
        onError: onErrorDialog('Config Password', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[savePasswordCommand] failed to save password command'],
        }),
    })

    const savePasswordCommandMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!activeConfigFile?.id || id !== activeConfigFile.id) {
                throw new Error('Only the active configuration password command can be saved.')
            }

            if (!activeConfigFile.isEncrypted) {
                throw new Error('Enable encryption before saving the password command.')
            }

            if (activeConfigFile.passCommand) {
                throw new Error('A password command is already saved for this configuration.')
            }

            if (activeConfigFile.pass) {
                throw new Error('Remove the saved password before adding a password command.')
            }

            const command = await rpc<string | null>('prompt', {
                title: 'Save Password Command',
                message: `Enter a command that outputs the password for "${activeConfigFile.label}".`,
                default: '',
                sensitive: false,
            }).catch(async (error) => {
                console.error('[Settings] Failed to prompt for password command', error)
                throw new Error('Failed to collect the password command.')
            })

            const trimmedCommand = command?.trim()

            if (!trimmedCommand) {
                return
            }

            useHostStore.getState().updateConfigFile(id, {
                pass: undefined,
                passCommand: trimmedCommand,
            })
            await message('The password command has been saved for this configuration.', {
                title: 'Config Password Command',
                kind: 'info',
                okLabel: 'OK',
            })
        },
        onError: onErrorDialog('Config Password', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[savePasswordCommand] failed to save password command'],
        }),
    })

    const removeSavedPasswordMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!activeConfigFile?.id || id !== activeConfigFile.id) {
                throw new Error('Only the active configuration password can be removed.')
            }

            if (!activeConfigFile.pass && !activeConfigFile.passCommand) {
                throw new Error('There is no saved password to remove.')
            }

            const confirmed = await ask(
                `Remove the saved password for "${activeConfigFile.label}"? You will be prompted for it next time it's needed.`,
                {
                    title: 'Remove Saved Password',
                    kind: 'warning',
                    okLabel: 'Remove',
                    cancelLabel: 'Cancel',
                }
            )

            if (!confirmed) {
                return
            }

            useHostStore.getState().updateConfigFile(id, {
                pass: undefined,
                passCommand: undefined,
            })
            await message('The saved password has been removed.', {
                title: 'Config Password',
                kind: 'info',
                okLabel: 'OK',
            })
        },
        onError: onErrorDialog('Config Password', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[removeSavedPassword] failed to remove saved password'],
        }),
    })

    return (
        <BaseSection
            header={{
                title: 'Config',
                endContent: (
                    <Dropdown shadow={platform === 'windows' ? 'none' : undefined}>
                        <DropdownTrigger>
                            <Button variant="faded" color="primary" data-focus-visible="false">
                                Add Config
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            onAction={(key) => {
                                setTimeout(async () => {
                                    if (key === 'import') {
                                        setIsCreateDrawerOpen(true)
                                    } else {
                                        setIsSyncDrawerOpen(true)
                                    }
                                }, 100)
                            }}
                            variant="faded"
                        >
                            <DropdownItem
                                key="import"
                                description="Edit using the CLI or UI"
                                startContent={<PlusIcon />}
                            >
                                Import Config
                            </DropdownItem>
                            <DropdownItem
                                key="sync"
                                description="Update using Git or similar"
                                startContent={<ImportIcon />}
                            >
                                Sync Config
                            </DropdownItem>
                        </DropdownMenu>
                    </Dropdown>
                ),
            }}
        >
            <div className="flex flex-col gap-2.5 px-4">
                {configFiles.map((configFile, configFileIndex) => (
                    <ConfigCard
                        key={configFile.id}
                        configFile={configFile}
                        index={configFileIndex}
                        activeConfigFile={activeConfigFile}
                        switchConfigMutation={switchConfigMutation}
                        setPasswordMutation={setPasswordMutation}
                        removePasswordMutation={removePasswordMutation}
                        savePasswordMutation={savePasswordMutation}
                        savePasswordCommandMutation={savePasswordCommandMutation}
                        removeSavedPasswordMutation={removeSavedPasswordMutation}
                        setFocusedConfigId={setFocusedConfigId}
                        setIsEditDrawerOpen={setIsEditDrawerOpen}
                        locateConfigMutation={locateConfigMutation}
                        exportConfigMutation={exportConfigMutation}
                    />
                ))}
            </div>

            <ConfigCreateDrawer
                isOpen={isCreateDrawerOpen}
                onClose={() => {
                    setIsCreateDrawerOpen(false)
                }}
            />

            <ConfigEditDrawer
                isOpen={isEditDrawerOpen}
                onClose={() => {
                    setIsEditDrawerOpen(false)
                    setFocusedConfigId(null)
                }}
                id={focusedConfigId}
            />

            <ConfigSyncDrawer
                isOpen={isSyncDrawerOpen}
                onClose={() => {
                    setIsSyncDrawerOpen(false)
                }}
            />
        </BaseSection>
    )
}

function ConfigCard({
    configFile,
    index,
    activeConfigFile,
    switchConfigMutation,
    setPasswordMutation,
    removePasswordMutation,
    savePasswordMutation,
    savePasswordCommandMutation,
    removeSavedPasswordMutation,
    setFocusedConfigId,
    setIsEditDrawerOpen,
    locateConfigMutation,
    exportConfigMutation,
}: {
    configFile: ConfigFile
    index: number
    activeConfigFile: ConfigFile | null | undefined
    switchConfigMutation: any
    setPasswordMutation: any
    removePasswordMutation: any
    savePasswordMutation: any
    savePasswordCommandMutation: any
    removeSavedPasswordMutation: any
    setFocusedConfigId: (id: string) => void
    setIsEditDrawerOpen: (open: boolean) => void
    locateConfigMutation: any
    exportConfigMutation: any
}) {
    const isActive = configFile.id === activeConfigFile?.id
    const queryClient = useQueryClient()

    const disabledKeys = useMemo(() => {
        if (!isActive) {
            return [
                'enable',
                'disable',
                'update',
                'save-password',
                'save-password-command',
                'remove-password',
            ]
        }

        if (!configFile.isEncrypted) {
            return [
                'disable',
                'update',
                'save-password',
                'save-password-command',
                'remove-password',
            ]
        }

        const disabled = ['enable']

        if (configFile.passCommand || configFile.pass) {
            disabled.push('save-password', 'save-password-command')
        } else {
            disabled.push('remove-password')
        }

        return disabled
    }, [configFile, isActive])

    return (
        <Card
            isPressable={true}
            shadow="sm"
            className={`group/card h-24 gap-2 bg-content2 ${configFile.id === activeConfigFile?.id ? 'border-2 border-primary' : ''}`}
            onPress={() => {
                setTimeout(() => {
                    switchConfigMutation.mutate(configFile)
                }, 100)
            }}
        >
            <CardBody className="flex flex-row items-center justify-start w-full gap-2.5">
                <Avatar
                    fallback={`#${index + 1}`}
                    className="text-large"
                    size="lg"
                    color={'default'}
                />
                <div className="flex flex-col gap-1 ml-0.5">
                    <p className="text-large">{configFile.label}</p>
                    <div className="flex flex-row gap-2">
                        {configFile.id === activeConfigFile?.id && (
                            <Chip color="primary" size="sm">
                                ACTIVE
                            </Chip>
                        )}
                        {!!configFile.sync && <Chip size="sm">SYNCED</Chip>}
                        {configFile.isEncrypted && (
                            <Chip color="success" size="sm">
                                ENCRYPTED
                            </Chip>
                        )}
                        {!configFile.isEncrypted && (
                            <Chip color="warning" size="sm">
                                UNENCRYPTED
                            </Chip>
                        )}
                    </div>
                </div>
                <div className="flex-1" />
                <div className="flex flex-row items-center transition-opacity duration-150 opacity-0 group-hover/card:opacity-100">
                    <Tooltip content="Encryption Settings" color="foreground" size="lg">
                        <div>
                            <Dropdown shadow={platform === 'windows' ? 'none' : undefined}>
                                <DropdownTrigger>
                                    <Button
                                        isIconOnly={true}
                                        variant="light"
                                        size="lg"
                                        isLoading={
                                            (setPasswordMutation.isPending &&
                                                setPasswordMutation.variables === configFile.id) ||
                                            (removePasswordMutation.isPending &&
                                                removePasswordMutation.variables ===
                                                    configFile.id) ||
                                            (savePasswordMutation.isPending &&
                                                savePasswordMutation.variables === configFile.id) ||
                                            (savePasswordCommandMutation.isPending &&
                                                savePasswordCommandMutation.variables ===
                                                    configFile.id) ||
                                            (removeSavedPasswordMutation.isPending &&
                                                removeSavedPasswordMutation.variables ===
                                                    configFile.id)
                                        }
                                    >
                                        <LockIcon className="w-5 h-5" />
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    disabledKeys={disabledKeys}
                                    onAction={(key) => {
                                        setTimeout(() => {
                                            if (!configFile.id) {
                                                return
                                            }

                                            const targetId = configFile.id

                                            switch (key) {
                                                case 'enable':
                                                    setPasswordMutation.mutate(targetId)
                                                    break
                                                case 'disable':
                                                    removePasswordMutation.mutate(targetId)
                                                    break
                                                case 'update':
                                                    setPasswordMutation.mutate(targetId)
                                                    break
                                                case 'save-password':
                                                    savePasswordMutation.mutate(targetId)
                                                    break
                                                case 'save-password-command':
                                                    savePasswordCommandMutation.mutate(targetId)
                                                    break
                                                case 'remove-password':
                                                    removeSavedPasswordMutation.mutate(targetId)
                                                    break
                                                default:
                                                    break
                                            }
                                        }, 100)
                                    }}
                                >
                                    <DropdownItem
                                        key="enable"
                                        startContent={<LockIcon className="size-4" />}
                                    >
                                        Enable Encryption
                                    </DropdownItem>
                                    <DropdownItem
                                        key="disable"
                                        startContent={<LockIcon className="size-4" />}
                                    >
                                        Disable Encryption
                                    </DropdownItem>
                                    <DropdownItem
                                        key="update"
                                        startContent={<LockIcon className="size-4" />}
                                    >
                                        Update Password
                                    </DropdownItem>
                                    {configFile.isEncrypted &&
                                    !configFile.pass &&
                                    !configFile.passCommand ? (
                                        <DropdownItem
                                            key="save-password"
                                            startContent={<LockIcon className="size-4" />}
                                        >
                                            Save Password
                                        </DropdownItem>
                                    ) : null}
                                    {configFile.isEncrypted && !configFile.passCommand ? (
                                        <DropdownItem
                                            key="save-password-command"
                                            startContent={<LockIcon className="size-4" />}
                                        >
                                            Save Password Command
                                        </DropdownItem>
                                    ) : null}
                                    {configFile.isEncrypted &&
                                    (configFile.pass || configFile.passCommand) ? (
                                        <DropdownItem
                                            key="remove-password"
                                            startContent={<LockIcon className="size-4" />}
                                        >
                                            Remove Saved Password
                                        </DropdownItem>
                                    ) : null}
                                </DropdownMenu>
                            </Dropdown>
                        </div>
                    </Tooltip>
                    {configFile.id !== 'default' && !isActive && !configFile.sync && (
                        <Tooltip content="Edit Config" color="foreground" size="lg">
                            <div>
                                <Button
                                    isIconOnly={true}
                                    variant="light"
                                    size="lg"
                                    onPress={() => {
                                        setFocusedConfigId(configFile.id!)
                                        setIsEditDrawerOpen(true)
                                    }}
                                >
                                    <PencilIcon className="w-5 h-5" />
                                </Button>
                            </div>
                        </Tooltip>
                    )}
                    {configFile.id !== 'default' && (
                        <Tooltip content="Delete Config" color="danger" size="lg">
                            <div>
                                <Button
                                    isIconOnly={true}
                                    variant="light"
                                    size="lg"
                                    onPress={() => {
                                        setTimeout(async () => {
                                            const confirmed = await ask(
                                                `Are you sure you want to delete config ${configFile.label}?`,
                                                {
                                                    title: 'Delete Config',
                                                    kind: 'warning',
                                                    okLabel: 'Delete',
                                                    cancelLabel: 'Cancel',
                                                }
                                            )

                                            if (!confirmed) {
                                                return
                                            }

                                            try {
                                                if (!configFile.sync) {
                                                    // validate: false so a manually-deleted
                                                    // directory doesn't throw before we can still
                                                    // clean up the store entry.
                                                    const path = await getConfigPath({
                                                        id: configFile.id!,
                                                        validate: false,
                                                    })

                                                    try {
                                                        await removeDir(
                                                            path.replace('rclone.conf', '')
                                                        )
                                                    } catch (removeError) {
                                                        // An already-gone directory is fine — fall
                                                        // through and still remove the store entry.
                                                        const detail =
                                                            removeError instanceof Error
                                                                ? removeError.message
                                                                : String(removeError)
                                                        if (
                                                            !/no such file|not found|cannot find|does not exist|directory not found/i.test(
                                                                detail
                                                            )
                                                        ) {
                                                            throw removeError
                                                        }
                                                    }
                                                }

                                                const deletedWasActive =
                                                    activeConfigFile?.id === configFile.id

                                                // Deleting the active config falls back to
                                                // 'default': move the running daemon AND any
                                                // config-sync link off the now-deleted file,
                                                // mirroring a normal switch (otherwise both keep
                                                // pointing at a config that no longer exists). The
                                                // sync link is recognized as ours via the persisted
                                                // marker, so ordering vs removeConfigFile no longer
                                                // affects ownership — but removeConfigFile must still
                                                // precede any restart so the snapshot can't resurrect
                                                // the deleted config, and reconcile must precede the
                                                // restart so the snapshot carries any relocated
                                                // defaultConfigPath.
                                                if (deletedWasActive) {
                                                    useHostStore
                                                        .getState()
                                                        .setActiveConfigFile('default')

                                                    const sync = await reconcileConfigSync()
                                                    if (
                                                        sync.error &&
                                                        useHostStore.getState().syncConfigToSystem
                                                    ) {
                                                        await message(
                                                            `Deleted the config, but the terminal config sync link could not be updated:\n${sync.error}`,
                                                            {
                                                                title: 'Config sync',
                                                                kind: 'warning',
                                                                okLabel: 'OK',
                                                            }
                                                        )
                                                    }
                                                }

                                                useHostStore
                                                    .getState()
                                                    .removeConfigFile(configFile.id!)

                                                if (deletedWasActive) {
                                                    // The delete has already committed; a transient
                                                    // re-point failure must not read as "Delete
                                                    // failed" nor skip the cache reset below. The
                                                    // daemon re-points to default on the next
                                                    // restart/reconcile regardless.
                                                    try {
                                                        const defaultCfg = useHostStore
                                                            .getState()
                                                            .configFiles.find(
                                                                (c) => c.id === 'default'
                                                            )
                                                        if (
                                                            Boolean(configFile.isEncrypted) ||
                                                            Boolean(defaultCfg?.isEncrypted)
                                                        ) {
                                                            // Emit-only. If the restart can't even be
                                                            // requested, the daemon may keep serving
                                                            // the deleted config until the next app
                                                            // restart. The delete is already
                                                            // committed, so warn (don't roll back) —
                                                            // startup reconcile re-points regardless.
                                                            if (!(await restartActiveRclone())) {
                                                                await message(
                                                                    'Deleted the config, but rclone could not be restarted onto the default config. It will switch over on the next app restart.',
                                                                    {
                                                                        title: 'Config deleted',
                                                                        kind: 'warning',
                                                                        okLabel: 'OK',
                                                                    }
                                                                )
                                                            }
                                                        } else {
                                                            const path = await getConfigPath({
                                                                id: 'default',
                                                                validate: true,
                                                            })
                                                            await rclone('/config/setpath', {
                                                                params: { query: { path } },
                                                            })
                                                        }
                                                    } catch (repointError) {
                                                        console.warn(
                                                            '[deleteConfig] daemon re-point after delete failed',
                                                            repointError
                                                        )
                                                    }
                                                }

                                                // Mirror switchConfigMutation's cache reset so the
                                                // UI doesn't keep showing the deleted config's data
                                                // after the daemon moved to default.
                                                if (deletedWasActive) {
                                                    await queryClient.cancelQueries()
                                                    await queryClient.resetQueries()
                                                }
                                            } catch (error) {
                                                await onErrorDialog('Delete Config')(error)
                                            }
                                        }, 100)
                                    }}
                                >
                                    <Trash2Icon className="w-5 h-5" />
                                </Button>
                            </div>
                        </Tooltip>
                    )}
                    <Tooltip content="Locate Config" color="foreground" size="lg">
                        <div>
                            <Button
                                isIconOnly={true}
                                variant="light"
                                size="lg"
                                onPress={() => {
                                    locateConfigMutation.mutate(configFile.id!)
                                }}
                                isLoading={
                                    locateConfigMutation.isPending &&
                                    locateConfigMutation.variables === configFile.id
                                }
                            >
                                <FolderOpenIcon className="w-5 h-5" />
                            </Button>
                        </div>
                    </Tooltip>
                    <Tooltip content="Export Config" color="foreground" size="lg">
                        <div>
                            <Button
                                isIconOnly={true}
                                variant="light"
                                size="lg"
                                onPress={() => {
                                    exportConfigMutation.mutate({
                                        id: configFile.id!,
                                        label: configFile.label,
                                    })
                                }}
                                isLoading={
                                    exportConfigMutation.isPending &&
                                    exportConfigMutation.variables?.id === configFile.id
                                }
                            >
                                <DownloadIcon className="w-5 h-5" />
                            </Button>
                        </div>
                    </Tooltip>
                </div>
            </CardBody>
        </Card>
    )
}
