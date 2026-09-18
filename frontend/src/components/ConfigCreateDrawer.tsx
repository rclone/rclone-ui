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

import { UploadIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import { getConfigPath } from '../../lib/rclone/common'
import { useHostStore } from '../../store/host'
import type { ConfigFile } from '../../types/config'
import { message, pickPath } from '../../lib/api/dialog'
import { mkdir, readFile, writeFile } from '../../lib/rclone/daemon-fs'
import { sep } from '../../lib/api/paths'

export default function ConfigCreateDrawer({
    onClose,
    isOpen,
}: {
    onClose: () => void
    isOpen: boolean
}) {
    const [config, setConfig] = useState<Partial<ConfigFile>>({
        label: 'New Config',
    })
    const [configContent, setConfigContent] = useState<string | null>(null)

    const [isPasswordCommand, setIsPasswordCommand] = useState(false)

    const isEncrypted = useMemo(
        () => configContent?.includes('RCLONE_ENCRYPT_V0:'),
        [configContent]
    )

    const createConfigMutation = useMutation({
        mutationFn: async ({
            label,
            pass,
            passCommand,
            content,
            isPasswordCommand,
            isEncrypted,
        }: {
            label: string
            pass?: string
            passCommand?: string
            content: string
            isPasswordCommand: boolean
            isEncrypted: boolean
        }) => {
            const savedPass = isPasswordCommand ? undefined : pass
            const savedPassCommand = isPasswordCommand ? passCommand : undefined

            const generatedId = crypto.randomUUID()
            const configPath = await getConfigPath({ id: generatedId, validate: false })

            await mkdir(configPath.replace(sep + 'rclone.conf', ''))
            await writeFile(configPath, content)
            console.log('[createConfig] saved config to', configPath)

            const newConfig = {
                id: generatedId,
                label,
                pass: savedPass,
                passCommand: savedPassCommand,
                isEncrypted,
                sync: undefined,
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
            log: ['[createConfig] failed to save config'],
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
                )}
            >
                {(close) => (
                    <>
                        <DrawerHeader className="flex flex-col gap-1">Import Config</DrawerHeader>
                        <DrawerBody>
                            <div className="flex flex-col gap-4">
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

                                {isEncrypted && (
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

                                <Textarea
                                    className="w-full"
                                    label={
                                        <div className="flex items-center gap-1.5">
                                            <p className="text-medium">Config</p>
                                            <Button
                                                isIconOnly={true}
                                                variant="light"
                                                size="sm"
                                                onPress={async () => {
                                                    const selectedFile = await pickPath({
                                                        directory: false,
                                                        multiple: false,
                                                        title: 'Select a config file',
                                                    })

                                                    if (!selectedFile) {
                                                        return
                                                    }

                                                    let content = await readFile(selectedFile)

                                                    if (selectedFile.endsWith('.json')) {
                                                        const importedRemotes = JSON.parse(
                                                            content
                                                        ) as Record<string, object>
                                                        content = Object.entries(importedRemotes)
                                                            .map(([name, remote]) => {
                                                                const remoteName = `[${name}]`
                                                                const remoteConfig = Object.entries(
                                                                    remote
                                                                )
                                                                    .map(([key, value]) => {
                                                                        return `${key} = ${value}`
                                                                    })
                                                                    .join('\n')
                                                                return `${remoteName}\n${remoteConfig}`
                                                            })
                                                            .reduce((acc, curr) => {
                                                                return `${curr}\n\n${acc}`
                                                            }, '')
                                                    }

                                                    setConfigContent(content)
                                                    setConfig({
                                                        ...config,
                                                        label:
                                                            config.label ||
                                                            selectedFile.split(sep).pop() ||
                                                            'New Config',
                                                        isEncrypted:
                                                            content.includes('RCLONE_ENCRYPT_V0:'),
                                                    })
                                                }}
                                            >
                                                <UploadIcon className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    }
                                    labelPlacement="outside"
                                    placeholder="Paste your config here or import an existing file"
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
                                isDisabled={createConfigMutation.isPending}
                                data-focus-visible="false"
                                onPress={async () => {
                                    if (!config.label) {
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

                                    if (isEncrypted && isPasswordCommand && !config.passCommand) {
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

                                    createConfigMutation.mutate({
                                        label: config.label,
                                        pass: config.pass,
                                        passCommand: config.passCommand,
                                        content: configContent,
                                        isPasswordCommand: isPasswordCommand,
                                        isEncrypted: !!isEncrypted,
                                    })
                                }}
                            >
                                {createConfigMutation.isPending ? 'Saving...' : 'Import'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
