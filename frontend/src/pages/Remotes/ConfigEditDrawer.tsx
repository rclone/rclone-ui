import {
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Textarea,
    cn,
} from '@heroui/react'
import { Button } from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { startTransition, useEffect, useState } from 'react'
import { message } from '@/dialog'
import { onErrorDialog } from '@/lib/errors'
import queryClient from '@/lib/query'
import rclone from '@/lib/rclone/client'
import { daemonConfigPath, readDaemonConfig, writeDaemonConfig } from '@/lib/rclone/config-file'
import { forgetRemoteHealth } from '@/lib/rclone/health'

/**
 * The rclone configuration file, as text. There is exactly one, and where it lives is rclone's
 * decision: the daemon is asked (`/config/paths`) rather than told.
 */
export default function ConfigEditDrawer({
    onClose,
    isOpen,
}: {
    onClose: () => void
    isOpen: boolean
}) {
    const [configContent, setConfigContent] = useState<string | null>(null)

    const pathQuery = useQuery({
        queryKey: ['config', 'path'],
        queryFn: daemonConfigPath,
        enabled: isOpen,
    })

    const updateConfigMutation = useMutation({
        mutationFn: async (content: string) => {
            await writeDaemonConfig(content)
            // rclone re-reads a changed config; the remotes in it may have changed too.
            await rclone('/fscache/clear').catch(() => null)
            queryClient.invalidateQueries({ queryKey: ['remotes'] })
            queryClient.invalidateQueries({ queryKey: ['remote'] })
            queryClient.invalidateQueries({ queryKey: ['dashboard', 'remotes'] })
            forgetRemoteHealth()
            return true
        },
        onSuccess: () => {
            onClose()
        },
        onError: onErrorDialog('Failed to save config', undefined, {
            okLabel: 'OK',
            log: ['[updateConfig] failed to save config'],
        }),
    })

    useEffect(() => {
        if (isOpen && configContent === null) {
            readDaemonConfig()
                .then(({ text }) => startTransition(() => setConfigContent(text)))
                .catch(
                    onErrorDialog('Failed to read config', undefined, {
                        log: ['[ConfigEditDrawer] failed to read config'],
                    })
                )
        }

        if (!isOpen) {
            startTransition(() => setConfigContent(null))
        }
    }, [isOpen, configContent])

    return (
        <Drawer
            isOpen={isOpen}
            placement={'bottom'}
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent className={cn('bg-content1/80 backdrop-blur-md dark:bg-content1/90')}>
                {(close) => (
                    <>
                        <DrawerHeader className="flex flex-col gap-1">
                            <p>Config file</p>
                            <p className="font-normal text-foreground-500 text-small">
                                {pathQuery.data ?? ' '}
                            </p>
                        </DrawerHeader>
                        <DrawerBody>
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
                                onValueChange={setConfigContent}
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
                                    if (!configContent) {
                                        await message('Content is required', {
                                            title: 'Failed to save config',
                                            kind: 'error',
                                            okLabel: 'OK',
                                        })
                                        return
                                    }

                                    updateConfigMutation.mutate(configContent)
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
