import { Button, Chip, cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { startTransition, useEffect, useMemo, useState } from 'react'
import { formatErrorMessage } from '../../../lib/errors'
import { updateSettings, useSettings } from '../../../lib/settings'
import { ask, launcher, message, platform } from '../../../lib/shell'
import { forgetLauncherHistory } from './launcherHistory'
import { SettingRow, SettingsGroup } from './SettingsGroup'
import { SECTIONS } from './sections'
import { keycaps, readRecorderKey } from './shortcut'

const DEFAULT_LAUNCHER_SHORTCUT = launcher.defaultShortcut()

const MACOS = platform() === 'macos'

// A launcher shortcut needs at least one modifier. The two texts below name the modifiers as they
// are on this OS's keyboards, so each is a whole message per OS. The key names stay as they are.

function shortcutHelp(): string {
    return MACOS
        ? t`Press it in any app to open the launcher. To change it, select Record shortcut, then press the new keys with Command, Control or Option. Escape cancels.`
        : t`Press it in any app to open the launcher. To change it, select Record shortcut, then press the new keys with Ctrl or Alt. Escape cancels.`
}

/** What the recorder says when a key was pressed without a modifier. */
function holdModifier(shortcut: string): string {
    return MACOS
        ? t`Hold Command, Control or Option with ${shortcut}.`
        : t`Hold Ctrl or Alt with ${shortcut}.`
}

export default function LauncherGroup() {
    const { settings } = useSettings()
    const launcherShortcut = settings?.general?.launcherShortcut || ''
    const forgetHistory = useMutation({ mutationFn: forgetLauncherHistory })

    const [isRecording, setIsRecording] = useState(false)
    const [feedback, setFeedback] = useState<string | null>(null)

    const resolvedShortcut = useMemo(
        () => launcherShortcut || DEFAULT_LAUNCHER_SHORTCUT,
        [launcherShortcut]
    )
    const isDefault = resolvedShortcut === DEFAULT_LAUNCHER_SHORTCUT

    const updateLauncherShortcutMutation = useMutation({
        mutationFn: async (value: string) => {
            // Register the shortcut first, so one that the OS refuses (because another app holds
            // it) is never saved.
            await launcher.setShortcut(value)
            // "" means the default. The app registers whatever shortcut the settings name.
            const normalizedShortcut = value === DEFAULT_LAUNCHER_SHORTCUT ? '' : value
            try {
                await updateSettings({ launcherShortcut: normalizedShortcut })
            } catch (error) {
                // The save failed, so register the shortcut the settings still name again.
                await launcher.setShortcut(resolvedShortcut).catch((restoreError: unknown) => {
                    console.error('[Launcher] Failed to restore the shortcut', restoreError)
                })
                throw error
            }
        },
        onSuccess: (_, shortcut) => {
            startTransition(() => setFeedback(t`The launcher now opens with ${shortcut}.`))
        },
        onError: async (error) => {
            console.error('[Launcher] Failed to update shortcut', error)
            setFeedback(t`The shortcut didn't change.`)
            const reason = formatErrorMessage(error, String(error))
            await message(t`Rclone UI couldn't change the launcher's shortcut. ${reason}`, {
                title: t`Launcher`,
                kind: 'error',
            })
        },
    })
    // Only one shortcut change runs at a time. Recording and Reset wait until the last one is
    // registered and saved.
    const isSaving = updateLauncherShortcutMutation.isPending

    useEffect(() => {
        if (!isRecording) {
            return
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            const pressed = readRecorderKey(event)
            if (pressed.kind === 'pass') {
                return
            }
            event.preventDefault()
            event.stopPropagation()

            if (pressed.kind === 'cancel') {
                startTransition(() => {
                    setIsRecording(false)
                    setFeedback(null)
                })
                return
            }

            if (isSaving) {
                return
            }

            if (pressed.kind === 'wait') {
                startTransition(() => {
                    setFeedback(t`Keep holding them, and press a letter, number or symbol.`)
                })
                return
            }

            if (pressed.kind === 'bare') {
                startTransition(() => setFeedback(holdModifier(pressed.shortcut)))
                return
            }

            const shortcut = pressed.shortcut
            startTransition(() => {
                setIsRecording(false)
                setFeedback(t`Saving ${shortcut}…`)
            })
            updateLauncherShortcutMutation.mutate(shortcut)
        }

        window.addEventListener('keydown', handleKeyDown, { capture: true })

        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true })
        }
    }, [isRecording, isSaving, updateLauncherShortcutMutation.mutate])

    return (
        <SettingsGroup id="launcher" {...SECTIONS.launcher}>
            <div className="flex flex-col gap-4 p-5">
                <KeycapWell shortcut={resolvedShortcut} isRecording={isRecording} />

                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                            <span className="font-medium text-small">
                                <Trans>Shortcut</Trans>
                            </span>
                            {isDefault && !isRecording && (
                                <Chip size="sm" variant="flat" className="h-5 text-tiny">
                                    <Trans comment="Marks the launcher's shortcut as the one the app comes with.">
                                        Default
                                    </Trans>
                                </Chip>
                            )}
                        </div>
                        <p className="text-xs leading-relaxed text-default-500 text-pretty">
                            {shortcutHelp()}
                        </p>
                    </div>

                    <div className="flex flex-row flex-wrap gap-2">
                        <Button
                            size="sm"
                            color="primary"
                            variant={isRecording ? 'flat' : 'solid'}
                            onPress={() => {
                                if (isSaving) {
                                    return
                                }

                                if (isRecording) {
                                    setIsRecording(false)
                                    setFeedback(null)
                                    return
                                }

                                setFeedback(null)
                                setIsRecording(true)
                            }}
                            isDisabled={isSaving}
                            data-focus-visible="false"
                        >
                            {isRecording ? t`Cancel recording` : t`Record shortcut`}
                        </Button>
                        <Button
                            size="sm"
                            variant="flat"
                            onPress={() => {
                                setTimeout(() => {
                                    const shortcut = DEFAULT_LAUNCHER_SHORTCUT
                                    setIsRecording(false)
                                    setFeedback(t`Resetting to ${shortcut}…`)
                                    updateLauncherShortcutMutation.mutate(shortcut)
                                }, 100)
                            }}
                            isDisabled={isSaving || isDefault}
                            data-focus-visible="false"
                        >
                            <Trans>Reset to default</Trans>
                        </Button>
                    </div>

                    {feedback && (
                        <p className="text-xs text-default-500" aria-live="polite">
                            {feedback}
                        </p>
                    )}
                </div>
            </div>

            <SettingRow
                title={t`Search history`}
                description={t`The launcher ranks its results by what you pick and what you type to find it. This history stays on this computer.`}
            >
                <Button
                    size="sm"
                    variant="flat"
                    color="danger"
                    isDisabled={forgetHistory.isPending}
                    onPress={async () => {
                        const yes = await ask(
                            t`Delete the launcher history? The launcher forgets what you picked and what you typed to find it.`,
                            {
                                title: t`Delete history`,
                                kind: 'warning',
                                destructive: true,
                                okLabel: t`Delete history`,
                            }
                        )
                        if (!yes) {
                            return
                        }
                        try {
                            await forgetHistory.mutateAsync()
                            setFeedback(t`The launcher history was deleted.`)
                        } catch (error) {
                            const reason = formatErrorMessage(error)
                            setFeedback(t`Couldn't delete the launcher history: ${reason}`)
                        }
                    }}
                    data-focus-visible="false"
                >
                    <Trans>Delete history</Trans>
                </Button>
            </SettingRow>
        </SettingsGroup>
    )
}

function KeycapWell({ shortcut, isRecording }: { shortcut: string; isRecording: boolean }) {
    const caps = keycaps(shortcut, platform())
    return (
        <div
            className={cn(
                'flex items-center justify-center w-full min-h-20 px-5 py-4 rounded-xl',
                'bg-default-100 shadow-[inset_0_1px_3px_rgb(0_0_0/0.08)]',
                'dark:bg-black/40 dark:shadow-[inset_0_1px_3px_rgb(0_0_0/0.5)]',
                'transition-[box-shadow,background-color] duration-200 ease-out',
                isRecording &&
                    'bg-primary-50 shadow-[inset_0_0_0_2px_hsl(var(--heroui-primary))] dark:bg-primary-50/40 dark:shadow-[inset_0_0_0_2px_hsl(var(--heroui-primary))]'
            )}
        >
            {isRecording ? (
                <span className="flex items-center gap-2 font-medium text-small text-primary">
                    <span className="relative flex size-2">
                        <span className="absolute inline-flex w-full h-full rounded-full opacity-75 motion-safe:animate-ping bg-primary" />
                        <span className="relative inline-flex rounded-full size-2 bg-primary" />
                    </span>
                    <Trans>Press the new shortcut</Trans>
                </span>
            ) : (
                <>
                    <span className="sr-only">{shortcut}</span>
                    <span aria-hidden={true} className="flex items-center gap-2">
                        {caps.map((cap, i) => (
                            <Keycap key={`${i}-${cap}`} label={cap} />
                        ))}
                    </span>
                </>
            )}
        </div>
    )
}

function Keycap({ label }: { label: string }) {
    return (
        <kbd
            className={cn(
                'inline-grid place-items-center h-11 min-w-11 px-3 rounded-[10px] font-sans font-semibold text-default-700',
                label.length > 1 ? 'text-sm' : 'text-lg',
                'bg-linear-to-b from-white to-default-50',
                'shadow-[0_0_0_1px_rgb(0_0_0/0.09),0_2px_0_rgb(0_0_0/0.09),0_4px_8px_-2px_rgb(0_0_0/0.12),inset_0_1px_0_white]',
                'dark:from-default-200 dark:to-default-100 dark:text-default-800',
                'dark:shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_2px_0_rgb(0_0_0/0.7),0_4px_8px_-2px_rgb(0_0_0/0.6),inset_0_1px_0_rgb(255_255_255/0.1)]'
            )}
        >
            {label}
        </kbd>
    )
}
