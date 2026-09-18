import {
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
    Switch,
    Textarea,
    cn,
} from '@heroui/react'
import { Button } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import queryClient from '../../lib/query'
import rclone from '../../lib/rclone/client'
import { resolveConfigFilePath } from '../../lib/rclone/common'
import { daemonConfigPath } from '../../lib/rclone/config-file'
import { readFile, writeFile } from '../../lib/rclone/daemon-fs'
import { selectActiveConfigFile, useHostStore } from '../../store/host'
import { message } from '../../lib/api/dialog'

export default function ConfigEditDrawer({
    id,
    daemon = false,
    onClose,
    isOpen,
}: {
    id?: string | null
    /** Open on the file the daemon runs with, even when the app has no entry for it. */
    daemon?: boolean
    onClose: () => void
    isOpen: boolean
}) {
    const configFiles = useHostStore((state) => state.configFiles)
    const initialConfig = configFiles.find((c) => c.id === id)
    const isActive = useHostStore((state) => selectActiveConfigFile(state)?.id === id)

    // The file is read and written through the daemon (rclone's own file endpoints), so the
    // active config is the file the daemon actually runs with, wherever it runs; any other
    // entry is the app's own file for it.
    const filePath = useCallback(
        () =>
            isActive || daemon
                ? daemonConfigPath()
                : resolveConfigFilePath(initialConfig, { validate: false }),
        [isActive, daemon, initialConfig]
    )

    const [configLabel, setConfigLabel] = useState<string | null>(null)
    const [configPass, setConfigPass] = useState<string | null>(null)
    const [configPassCommand, setConfigPassCommand] = useState<string | null>(null)
    const [configContent, setConfigContent] = useState<string | null>(null)

    const [isPasswordCommand, setIsPasswordCommand] = useState(false)

    const isEncrypted = useMemo(
        () => configContent?.includes('RCLONE_ENCRYPT_V0:'),
        [configContent]
    )

    const updateConfigMutation = useMutation({
        mutationFn: async ({
            label,
            pass,
            content,
            passCommand,
            isPasswordCommand,
            isEncrypted,
        }: {
            label: string
            pass?: string
            content: string
            passCommand?: string
            isPasswordCommand?: boolean
            isEncrypted?: boolean
        }) => {
            const savedPass = isPasswordCommand ? undefined : pass
            const savedPassCommand = isPasswordCommand ? passCommand : undefined

            await writeFile(await filePath(), content)
            // rclone re-reads a changed config; the remotes in it may have changed too.
            await rclone('/fscache/clear').catch(() => null)
            queryClient.invalidateQueries({ queryKey: ['remotes'] })
            queryClient.invalidateQueries({ queryKey: ['remote'] })
            queryClient.invalidateQueries({ queryKey: ['dashboard', 'remotes'] })

            if (id && initialConfig) {
                useHostStore.getState().updateConfigFile(id, {
                    label: label,
                    pass: savedPass,
                    passCommand: savedPassCommand,
                    isEncrypted: !!isEncrypted,
                })
            }

            return true
        },
        onSuccess: () => {
            onClose()
        },
        onError: onErrorDialog('Failed to save config', undefined, {
            okLabel: 'OK',
            capture: false,
            log: ['[updateConfig] failed to save config'],
        }),
    })

    const initializeConfig = useCallback(async () => {
        if (!initialConfig && !daemon) {
            return
        }

        const text = await readFile(await filePath())

        startTransition(() => {
            setConfigContent(text)
            setConfigLabel(initialConfig?.label ?? '')
            setConfigPass(initialConfig?.pass || null)
            setConfigPassCommand(initialConfig?.passCommand || null)
            setIsPasswordCommand(!!initialConfig?.passCommand)
        })
    }, [initialConfig, daemon, filePath])

    useEffect(() => {
        if (isOpen && configContent === null && configLabel === null) {
            initializeConfig()
        }

        if (!isOpen) {
            startTransition(() => {
                setConfigContent(null)
                setConfigLabel(null)
                setConfigPass(null)
                setConfigPassCommand(null)
                setIsPasswordCommand(false)
            })
        }
    }, [isOpen, configLabel, initializeConfig, configContent])

    if (!id && !daemon) {
        return null
    }

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
                )}
            >
                {(close) => (
                    <>
                        <DrawerHeader className="flex flex-col gap-1">
                            {initialConfig ? `Edit ${configLabel}` : 'Config file'}
                        </DrawerHeader>
                        <DrawerBody>
                            <div className="flex flex-col gap-4">
                                {initialConfig && (
                                    <Input
                                        name="label"
                                        label="Name"
                                        labelPlacement="outside"
                                        placeholder="Enter a name for your config"
                                        type="text"
                                        value={configLabel || ''}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                        onValueChange={(value) => {
                                            setConfigLabel(value)
                                        }}
                                        isClearable={true}
                                        onClear={() => {
                                            setConfigLabel(null)
                                        }}
                                        size="lg"
                                    />
                                )}

                                {initialConfig && isEncrypted && (
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
                                        value={
                                            (isPasswordCommand ? configPassCommand : configPass) ||
                                            ''
                                        }
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                        onValueChange={(value) => {
                                            if (isPasswordCommand) {
                                                setConfigPassCommand(value)
                                            } else {
                                                setConfigPass(value)
                                            }
                                        }}
                                        isClearable={true}
                                        onClear={() => {
                                            if (isPasswordCommand) {
                                                setConfigPassCommand(null)
                                            } else {
                                                setConfigPass(null)
                                            }
                                        }}
                                        size="lg"
                                    />
                                )}

                                <Textarea
                                    className="w-full"
                                    name="content"
                                    label={
                                        <div className="flex items-center gap-1.5">
                                            <p className="text-medium">Config</p>
                                        </div>
                                    }
                                    labelPlacement="outside"
                                    placeholder="Update your config here"
                                    value={configContent || ''}
                                    onValueChange={(value) => {
                                        console.log(value)
                                        setConfigContent(value)
                                    }}
                                    autoCapitalize="off"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                    minRows={14}
                                    rows={14}
                                    maxRows={14}
                                    disableAutosize={true}
                                    size="lg"
                                    onClear={() => {
                                        setConfigContent(null)
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
                                isDisabled={updateConfigMutation.isPending}
                                data-focus-visible="false"
                                onPress={async () => {
                                    if (!configLabel) {
                                        await message('Label is required', {
                                            title: 'Failed to save config',
                                            kind: 'error',
                                            okLabel: 'OK',
                                        })
                                        return
                                    }

                                    if (!configContent) {
                                        await message('Content is required', {
                                            title: 'Failed to save config',
                                            kind: 'error',
                                            okLabel: 'OK',
                                        })
                                        return
                                    }

                                    if (isEncrypted && isPasswordCommand && !configPassCommand) {
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

                                    updateConfigMutation.mutate({
                                        label: configLabel,
                                        pass: configPass || undefined,
                                        content: configContent,
                                        passCommand: configPassCommand || undefined,
                                        isPasswordCommand: isPasswordCommand,
                                        isEncrypted:
                                            configContent?.includes('RCLONE_ENCRYPT_V0:') || false,
                                    })
                                }}
                            >
                                {updateConfigMutation.isPending ? 'Saving...' : 'Save Changes'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
