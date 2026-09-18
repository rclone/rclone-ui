import { Button, Checkbox, Chip, Select, SelectItem } from '@heroui/react'
import * as Sentry from '@sentry/browser'
import { useMutation, useQuery } from '@tanstack/react-query'

import { useMemo, useState } from 'react'

import { usePersistedStore } from '../../../store/persisted'
import BaseSection from './BaseSection'
import {
    type UpdateInfo,
    autostartSet,
    relaunch,
    updateCheck,
    updateInstall,
} from '../../../lib/api/app'
import { ask, message } from '../../../lib/api/dialog'
import { useCapabilities } from '../../../lib/api/host'
import { rpc } from '../../../lib/api/rpc'
import { openUrl } from '../../../lib/api/shell'

export default function GeneralSection() {
    const startOnBoot = usePersistedStore((state) => state.startOnBoot)
    const setStartOnBoot = usePersistedStore((state) => state.setStartOnBoot)

    const appearance = usePersistedStore((state) => state.appearance)
    const caps = useCapabilities()

    const [updateButtonText, setUpdateButtonText] = useState('Check for updates')
    const [update, setUpdate] = useState<UpdateInfo | null>(null)

    const flathubQuery = useQuery({
        queryKey: ['flathub'],
        queryFn: async () => {
            const flathub = await rpc<boolean>('is_flatpak')
            return flathub
        },
    })

    const isFlathub = useMemo(() => flathubQuery.data ?? true, [flathubQuery.data])

    const checkUpdatesMutation = useMutation({
        mutationFn: async () => {
            if (!update) {
                try {
                    console.log('checking for updates')
                    setUpdateButtonText('Checking...')
                    let receivedUpdate: UpdateInfo | null = null
                    try {
                        receivedUpdate = await updateCheck()
                    } catch (e) {
                        Sentry.captureException(e)
                        console.error(e)
                        setUpdateButtonText('Failed to check')
                        return
                    }
                    console.log('receivedUpdate', JSON.stringify(receivedUpdate, null, 2))
                    if (!receivedUpdate) {
                        setUpdateButtonText('Up to date')
                        return
                    }
                    console.log(
                        `found update ${receivedUpdate.version} from ${receivedUpdate.date} with notes ${receivedUpdate.body}`
                    )
                    setUpdate(receivedUpdate)
                    setUpdateButtonText('Tap to update')
                } catch (e) {
                    Sentry.captureException(e)
                    console.error(e)
                }
                return
            }

            setUpdateButtonText('Downloading...')

            try {
                let downloaded = 0
                let contentLength = 0

                await updateInstall((event) => {
                    // biome-ignore lint/style/useDefaultSwitchClause: <explanation>
                    switch (event.event) {
                        case 'Started': {
                            contentLength = event.data?.contentLength || 0
                            console.log(`started downloading ${event.data?.contentLength} bytes`)
                            break
                        }
                        case 'Progress': {
                            downloaded += event.data?.chunkLength ?? 0
                            console.log(`downloaded ${downloaded} from ${contentLength}`)
                            break
                        }
                        case 'Finished':
                            console.log('download finished')
                            break
                    }
                })
            } catch (error) {
                Sentry.captureException(error)
                console.error(error)
                setUpdateButtonText('Tap to retry')
                const wantsManualDownload = await ask(
                    'An error occurred in the update process. Please try again or tap "Download" to download the update manually.',
                    {
                        title: 'Update Error',
                        kind: 'error',
                        okLabel: 'Download',
                        cancelLabel: 'Cancel',
                    }
                )

                if (wantsManualDownload) {
                    await openUrl('https://github.com/rclone-ui/rclone-ui/releases/latest')
                }

                return
            }

            const answer = await ask('Update installed. Ready to restart?', {
                title: 'Update',
                kind: 'info',
                okLabel: 'Restart',
                cancelLabel: 'Later',
            })

            if (!answer) {
                return
            }

            await relaunch()
        },
    })

    return (
        <BaseSection header={{ title: 'General' }}>
            <div className="flex flex-row justify-center w-full gap-8 px-8">
                <div className="flex flex-col items-end flex-1 gap-2">
                    <h3 className="font-medium">Theme</h3>
                </div>

                <div className="flex flex-col w-3/5 gap-3">
                    <Select
                        label="App Theme"
                        selectedKeys={[appearance.app]}
                        onSelectionChange={(keys) => {
                            const value = Array.from(keys)[0] as 'light' | 'dark' | 'system'
                            usePersistedStore.setState((state) => ({
                                appearance: { ...state.appearance, app: value },
                            }))
                        }}
                        size="sm"
                        data-focus-visible="false"
                    >
                        <SelectItem key="system">System</SelectItem>
                        <SelectItem key="light">Light</SelectItem>
                        <SelectItem key="dark">Dark</SelectItem>
                    </Select>
                </div>
            </div>

            <div className="flex flex-row justify-center w-full gap-8 px-8">
                <div className="flex flex-col items-end flex-grow gap-2">
                    <h3 className="font-medium">Options</h3>
                </div>

                <div className="flex flex-col w-3/5 gap-3">
                    {caps.autostart && (
                        <Checkbox
                            isSelected={startOnBoot}
                            onValueChange={async (value) => {
                                try {
                                    setStartOnBoot(value)

                                    await autostartSet(value)
                                } catch (error) {
                                    setStartOnBoot(!value)
                                    await message(
                                        `An error occurred while toggling start on boot. ${error}`,
                                        {
                                            title: 'Error',
                                            kind: 'error',
                                        }
                                    )
                                }
                            }}
                        >
                            <div className="flex flex-row gap-2">
                                <p>Start on boot</p>
                                <Chip size="sm" color="primary">
                                    New
                                </Chip>
                            </div>
                        </Checkbox>
                    )}
                </div>
            </div>

            {!isFlathub && caps.updater && (
                <div className="flex flex-row justify-center w-full gap-8 px-8">
                    <div className="flex flex-col items-end flex-grow gap-2">
                        <h3 className="font-medium">Update</h3>
                    </div>

                    <div className="flex flex-col w-3/5 gap-3">
                        <Button
                            isLoading={checkUpdatesMutation.isPending}
                            onPress={() => setTimeout(() => checkUpdatesMutation.mutate(), 100)}
                        >
                            {updateButtonText}
                        </Button>
                    </div>
                </div>
            )}
        </BaseSection>
    )
}
