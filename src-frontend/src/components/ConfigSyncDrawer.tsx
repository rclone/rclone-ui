import {
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
    Switch,
    cn,
} from '@heroui/react'
import { Button } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import { UploadIcon } from 'lucide-react'
import { useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import { useHostStore } from '../../store/host'
import type { ConfigFile } from '../../types/config'
import { message, pickPath } from '../../lib/api/dialog'
import { exists, readFile } from '../../lib/rclone/daemon-fs'
import { isNativeMac } from '../../lib/api/os'
import { sep } from '../../lib/api/paths'

export default function ConfigSyncDrawer({
    onClose,
    isOpen,
}: {
    onClose: () => void
    isOpen: boolean
}) {
    const [config, setConfig] = useState<Partial<ConfigFile>>({
        label: 'New Config',
    })

    const [isPasswordCommand, setIsPasswordCommand] = useState(false)

    const createSyncConfigMutation = useMutation({
        mutationFn: async ({
            label,
            pass,
            isEncrypted,
            passCommand,
            sync,
            isPasswordCommand,
        }: {
            label: string
            sync: string
            isEncrypted?: boolean
            pass?: string
            passCommand?: string
            isPasswordCommand?: boolean
        }) => {
            const savedPass = isPasswordCommand ? undefined : pass
            const savedPassCommand = isPasswordCommand ? passCommand : undefined
            const savedIsEncrypted = isEncrypted || false
            const generatedId = crypto.randomUUID()

            const newConfig = {
                id: generatedId,
                label,
                isEncrypted: savedIsEncrypted,
                pass: savedPass,
                passCommand: savedPassCommand,
                sync,
            }

            useHostStore.getState().addConfigFile(newConfig)

            return true
        },
        onSuccess: () => {
            onClose()
        },
        onError: onErrorDialog('Failed to save config', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[createSyncConfig] failed to save config'],
        }),
    })

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
                        <DrawerHeader className="flex flex-col gap-1">Sync Config</DrawerHeader>
                        <DrawerBody>
                            <div className="flex flex-col gap-5">
                                <Switch
                                    size="lg"
                                    isSelected={config.isEncrypted}
                                    onValueChange={() =>
                                        setConfig({ ...config, isEncrypted: !config.isEncrypted })
                                    }
                                    color="primary"
                                >
                                    Encrypted
                                </Switch>

                                <Input
                                    label="Name"
                                    labelPlacement="outside"
                                    placeholder="Enter a name for your config"
                                    type="text"
                                    value={config.label}
                                    autoCapitalize="off"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                    onValueChange={(value) => {
                                        setConfig({ ...config, label: value })
                                    }}
                                    isClearable={true}
                                    onClear={() => {
                                        setConfig({ ...config, label: '' })
                                    }}
                                    size="lg"
                                />

                                {config.isEncrypted && (
                                    <Input
                                        label={
                                            <div className="flex items-center gap-1.5">
                                                <p className="text-medium">Password</p>
                                                <Switch
                                                    size="sm"
                                                    isSelected={isPasswordCommand}
                                                    onValueChange={() =>
                                                        setIsPasswordCommand(!isPasswordCommand)
                                                    }
                                                    color="primary"
                                                >
                                                    Command
                                                </Switch>
                                            </div>
                                        }
                                        labelPlacement="outside"
                                        placeholder={
                                            isPasswordCommand
                                                ? 'Enter the password command for your config file'
                                                : 'Leave blank to be prompted on every startup'
                                        }
                                        type={isPasswordCommand ? 'text' : 'password'}
                                        value={isPasswordCommand ? config.passCommand : config.pass}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                        onValueChange={(value) => {
                                            setConfig({
                                                ...config,
                                                ...(isPasswordCommand
                                                    ? { passCommand: value }
                                                    : { pass: value }),
                                            })
                                        }}
                                        isClearable={true}
                                        onClear={() => {
                                            setConfig({
                                                ...config,
                                                ...(isPasswordCommand
                                                    ? { passCommand: '' }
                                                    : { pass: '' }),
                                            })
                                        }}
                                        size="lg"
                                    />
                                )}

                                <Input
                                    label={
                                        <div className="flex items-center gap-1.5">
                                            <p className="text-medium">Config</p>
                                            <Button
                                                isIconOnly={true}
                                                variant="light"
                                                size="sm"
                                                onPress={async () => {
                                                    const getSavedLabel = (
                                                        a: any,
                                                        b: any,
                                                        c: any
                                                    ) => {
                                                        return a || b || c
                                                    }

                                                    try {
                                                        let selectedFolder = await pickPath({
                                                            directory: true,
                                                            multiple: false,
                                                            title: 'Select the root directory of your config file',
                                                        })

                                                        if (!selectedFolder) {
                                                            return
                                                        }

                                                        if (selectedFolder.endsWith(sep)) {
                                                            selectedFolder = selectedFolder.slice(
                                                                0,
                                                                -1
                                                            )
                                                        }

                                                        if (!(await exists(selectedFolder))) {
                                                            await message(
                                                                'The selected path does not exist',
                                                                {
                                                                    title: 'Failed to sync config',
                                                                    kind: 'error',
                                                                    okLabel: 'OK',
                                                                }
                                                            )
                                                            return
                                                        }

                                                        const configPath =
                                                            selectedFolder + sep + 'rclone.conf'

                                                        let content: string | null = null

                                                        try {
                                                            content = await readFile(configPath)
                                                        } catch {
                                                            await message(
                                                                'Could not find an rclone.conf file in the selected folder',
                                                                {
                                                                    title: 'Failed to sync config',
                                                                    kind: 'error',
                                                                    okLabel: 'OK',
                                                                }
                                                            )
                                                            return
                                                        }

                                                        if (!content) {
                                                            await message(
                                                                'Empty rclone.conf file',
                                                                {
                                                                    title: 'Failed to sync config',
                                                                    kind: 'error',
                                                                    okLabel: 'OK',
                                                                }
                                                            )
                                                            return
                                                        }

                                                        setConfig({
                                                            ...config,
                                                            label: getSavedLabel(
                                                                config.label,
                                                                configPath.split(sep).pop(),
                                                                'New Config'
                                                            ),
                                                            sync: selectedFolder,
                                                        })
                                                    } catch (error) {
                                                        await message(
                                                            error instanceof Error
                                                                ? error.message
                                                                : 'An unknown error occurred',
                                                            {
                                                                title: 'Failed to sync config',
                                                                kind: 'error',
                                                                okLabel: 'OK',
                                                            }
                                                        )
                                                    }
                                                }}
                                            >
                                                <UploadIcon className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    }
                                    labelPlacement="outside"
                                    placeholder="Select the folder containing your rclone.conf file"
                                    value={config.sync || ''}
                                    onValueChange={(value) => {
                                        console.log(value)
                                        setConfig({ ...config, sync: value })
                                    }}
                                    autoCapitalize="off"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                    type="textarea"
                                    size="lg"
                                    isClearable={true}
                                    onClear={() => {
                                        setConfig({ ...config, sync: '' })
                                    }}
                                    data-focus-visible="false"
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
                                onPress={async () => {
                                    if (!config.label) {
                                        await message('Label is required', {
                                            title: 'Failed to save config',
                                            kind: 'error',
                                            okLabel: 'OK',
                                        })
                                        return
                                    }

                                    if (!config.sync) {
                                        await message('Path is required', {
                                            title: 'Failed to save config',
                                            kind: 'error',
                                            okLabel: 'OK',
                                        })
                                        return
                                    }

                                    if (
                                        config.isEncrypted &&
                                        isPasswordCommand &&
                                        !config.passCommand
                                    ) {
                                        await message(
                                            'Password command is required for encrypted configs',
                                            {
                                                title: 'Failed to save config',
                                                kind: 'error',
                                                okLabel: 'OK',
                                            }
                                        )
                                        return
                                    }

                                    createSyncConfigMutation.mutate({
                                        label: config.label,
                                        pass: config.pass,
                                        isEncrypted: config.isEncrypted,
                                        passCommand: config.passCommand,
                                        sync: config.sync,
                                        isPasswordCommand: isPasswordCommand,
                                    })
                                }}
                                isDisabled={createSyncConfigMutation.isPending}
                                data-focus-visible="false"
                            >
                                {createSyncConfigMutation.isPending ? 'Saving...' : 'Sync'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
