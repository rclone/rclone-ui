import { Button, Checkbox, Chip, Input, Select, SelectItem } from '@heroui/react'
import * as Sentry from '@sentry/browser'
import { useMutation, useQuery } from '@tanstack/react-query'

import { EyeIcon } from 'lucide-react'
import { startTransition, useEffect, useMemo, useState } from 'react'

import { notify } from '../../../lib/notifications'
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
import { platform } from '../../../lib/api/os'
import { rpc } from '../../../lib/api/rpc'
import { openUrl } from '../../../lib/api/shell'

const DEFAULT_TOOLBAR_SHORTCUT = 'CmdOrCtrl+Shift+/'

const KEY_CODE_DISPLAY_MAP: Record<string, string> = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: 'Space',
}

function formatShortcutFromEvent(event: KeyboardEvent): string | null {
    const modifiers: string[] = []
    if (event.metaKey) {
        modifiers.push('Command')
    }
    if (event.ctrlKey) {
        modifiers.push('Ctrl')
    }
    if (event.altKey) {
        modifiers.push('Alt')
    }
    if (event.shiftKey) {
        modifiers.push('Shift')
    }

    const codeMapped = KEY_CODE_DISPLAY_MAP[event.code]
    let key = codeMapped || event.key

    if (key === 'Meta') {
        key = 'Command'
    } else if (key === 'Control') {
        key = 'Ctrl'
    } else if (key === ' ') {
        key = 'Space'
    } else if (key && key.length === 1) {
        key = key.toUpperCase()
    } else if (key) {
        key = key.charAt(0).toUpperCase() + key.slice(1)
    }

    if (!key || ['Shift', 'Ctrl', 'Alt', 'Command'].includes(key)) {
        return null
    }

    const uniqueModifiers = Array.from(new Set(modifiers))
    return [...uniqueModifiers, key].join('+')
}

export default function GeneralSection() {
    const settingsPass = usePersistedStore((state) => state.settingsPass)
    const setSettingsPass = usePersistedStore((state) => state.setSettingsPass)
    const [passwordInput, setPasswordInput] = useState('')
    const [passwordVisible, setPasswordVisible] = useState(false)

    const startOnBoot = usePersistedStore((state) => state.startOnBoot)
    const setStartOnBoot = usePersistedStore((state) => state.setStartOnBoot)

    const hideStartup = usePersistedStore((state) => state.hideStartup)
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

    useEffect(() => {
        // needed since the first value from the persisted store is undefined
        startTransition(() => {
            setPasswordInput(settingsPass || '')
        })
    }, [settingsPass])

    return (
        <BaseSection header={{ title: 'General' }}>
            <div className="flex flex-row justify-center w-full gap-8 px-8">
                <div className="flex flex-col items-end flex-1 gap-2">
                    <h3 className="font-medium">Password</h3>

                    <p className="text-xs text-neutral-500 text-end">
                        Set a password to protect this settings panel
                    </p>
                </div>

                <div className="flex flex-col w-3/5 gap-2">
                    <Input
                        placeholder="Enter password"
                        value={passwordInput}
                        onChange={(e) => setPasswordInput(e.target.value)}
                        size="lg"
                        autoCapitalize="none"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                        type={passwordVisible ? 'text' : 'password'}
                        endContent={
                            passwordInput && (
                                <Button
                                    onPress={() => setPasswordVisible(!passwordVisible)}
                                    isIconOnly={true}
                                    variant="light"
                                    data-focus-visible="false"
                                >
                                    <EyeIcon className="w-5 h-5" />
                                </Button>
                            )
                        }
                        data-focus-visible="false"
                    />

                    <div className="flex flex-row gap-2">
                        <Button
                            size="sm"
                            fullWidth={true}
                            onPress={async () => {
                                setSettingsPass(passwordInput)
                            }}
                            data-focus-visible="false"
                        >
                            Change password
                        </Button>

                        <Button
                            size="sm"
                            color="danger"
                            fullWidth={true}
                            onPress={async () => {
                                setPasswordInput('')
                                setSettingsPass(undefined)
                            }}
                            data-focus-visible="false"
                        >
                            Remove password
                        </Button>
                    </div>
                </div>
            </div>

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

                    {caps.window && platform !== 'macos' && (
                        <Select
                            label="Tray Theme"
                            selectedKeys={[appearance.tray]}
                            onSelectionChange={(keys) => {
                                const value = Array.from(keys)[0] as
                                    | 'light'
                                    | 'dark'
                                    | 'system'
                                    | 'color'
                                usePersistedStore.setState((state) => ({
                                    appearance: { ...state.appearance, tray: value },
                                }))
                                notify({
                                    title: 'Tray theme updated',
                                    body: 'Restart the app to apply the changes',
                                })
                            }}
                            size="sm"
                            data-focus-visible="false"
                        >
                            <SelectItem key="system">System</SelectItem>
                            <SelectItem key="light">Light</SelectItem>
                            <SelectItem key="dark">Dark</SelectItem>
                            <SelectItem key="color">Color</SelectItem>
                        </Select>
                    )}
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
                                // if (!licenseValid) {
                                //     await message('Community version does not support start on boot.', {
                                //         title: 'Missing license',
                                //         kind: 'error',
                                //     })
                                //     return
                                // }

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

                    {caps.window && (
                        <Checkbox
                            isSelected={!hideStartup}
                            onValueChange={(value) => {
                                usePersistedStore.setState(() => ({
                                    hideStartup: !value,
                                }))
                            }}
                        >
                            <p>Show Startup screen</p>
                        </Checkbox>
                    )}
                </div>
            </div>

            {caps.window && <ToolbarShortcutRow />}

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

// Toolbar shortcut recorder — relocated here from the retired Toolbar settings tab. Owns its own
// recording state so it stays a self-contained "Toolbar Shortcut" row in the General layout.
function ToolbarShortcutRow() {
    const toolbarShortcut = usePersistedStore((state) => state.toolbarShortcut)
    const setToolbarShortcut = usePersistedStore((state) => state.setToolbarShortcut)

    const [isRecording, setIsRecording] = useState(false)
    const [isSaving] = useState(false)
    const [feedback, setFeedback] = useState<string | null>(null)

    const resolvedShortcut = useMemo(
        () => toolbarShortcut ?? DEFAULT_TOOLBAR_SHORTCUT,
        [toolbarShortcut]
    )

    const updateToolbarShortcutMutation = useMutation({
        mutationFn: async (value: string) => {
            const normalizedShortcut = value === DEFAULT_TOOLBAR_SHORTCUT ? undefined : value
            await setToolbarShortcut(normalizedShortcut)
        },
        onSuccess: (_, value) => {
            startTransition(() => setFeedback(`Toolbar shortcut updated to ${value}`))
        },
        onError: async (error) => {
            console.error('[Toolbar] Failed to update shortcut', error)
            setFeedback('Failed to update toolbar shortcut')
            await message('Failed to update toolbar shortcut', {
                title: 'Toolbar',
                kind: 'error',
            })
        },
    })

    useEffect(() => {
        if (!isRecording) {
            return
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            event.preventDefault()
            event.stopPropagation()

            if (isSaving) {
                return
            }

            const shortcut = formatShortcutFromEvent(event)
            if (!shortcut) {
                startTransition(() => {
                    setFeedback('Press a non-modifier key to finish recording…')
                })
                return
            }

            startTransition(() => {
                setIsRecording(false)
                setFeedback(`Saving ${shortcut}…`)
            })
            updateToolbarShortcutMutation.mutate(shortcut)
        }

        window.addEventListener('keydown', handleKeyDown, { capture: true })

        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true })
        }
    }, [isRecording, isSaving, updateToolbarShortcutMutation.mutate])

    return (
        <div className="flex flex-row justify-center w-full gap-8 px-8">
            <div className="flex flex-col items-end flex-1 gap-2">
                <div className="flex items-center gap-2">
                    <h3 className="font-medium">Toolbar Shortcut</h3>
                    {isRecording && (
                        <Chip color="primary" size="sm">
                            Recording
                        </Chip>
                    )}
                </div>
                <p className="text-xs text-neutral-500 text-end">
                    Press &quot;Record shortcut&quot; and then the desired key combination.
                </p>
            </div>

            <div className="flex flex-col w-3/5 gap-3">
                <Input
                    label="Current"
                    value={
                        toolbarShortcut ? toolbarShortcut : `Default (${DEFAULT_TOOLBAR_SHORTCUT})`
                    }
                    readOnly={true}
                    data-focus-visible="false"
                />

                <div className="flex flex-row gap-2">
                    <Button
                        color="primary"
                        onPress={() => {
                            if (isSaving) {
                                return
                            }

                            if (isRecording) {
                                setIsRecording(false)
                                setFeedback(null)
                                return
                            }

                            setFeedback('Press the new shortcut keys…')
                            setIsRecording(true)
                        }}
                        isDisabled={isSaving}
                        data-focus-visible="false"
                    >
                        {isRecording ? 'Cancel recording' : 'Record shortcut'}
                    </Button>
                    <Button
                        variant="flat"
                        onPress={() => {
                            setTimeout(() => {
                                setIsRecording(false)
                                setFeedback(`Resetting to ${DEFAULT_TOOLBAR_SHORTCUT}…`)
                                updateToolbarShortcutMutation.mutate(DEFAULT_TOOLBAR_SHORTCUT)
                            }, 100)
                        }}
                        isDisabled={isSaving || resolvedShortcut === DEFAULT_TOOLBAR_SHORTCUT}
                        data-focus-visible="false"
                    >
                        Reset to default
                    </Button>
                </div>

                {feedback && (
                    <p className="text-xs text-neutral-400" aria-live="polite">
                        {feedback}
                    </p>
                )}
            </div>
        </div>
    )
}
