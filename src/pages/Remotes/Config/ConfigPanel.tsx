import { Button, cn, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import {
    DownloadBracket as DownloadBracketIcon,
    Folder as FolderIcon,
    LockSimple as LockSimpleIcon,
} from '@zappicon/react'
import { useMemo } from 'react'
import {
    askToRemember,
    type ConfigFile,
    ConfigStatus,
    exportConfig,
    forgetConfigPassword,
    promptPassword,
    rememberConfigPassword,
    removeConfigPassword,
    setConfigPassword,
    setPasswordCommand,
    unlockConfig,
    useConfig,
} from '../../../../lib/configs'
import { formatErrorMessage, onErrorDialog } from '../../../../lib/errors'
import { ask, currentWindow, message, prompt, revealPath, save } from '../../../../lib/shell'
import Alert from '../../../components/Alert'
import { Panel } from '../../../components/look/Panel'
import { StatusDot, type StatusKind } from '../../../components/look/Status'

export default function ConfigPanel() {
    // config.changed refetches the file, along with everything that depends on it.
    const { data: config, error, isError, isFetching, refetch } = useConfig()

    const exportConfigMutation = useMutation({
        mutationFn: async () => {
            await currentWindow.focus()
            const path = await save({
                title: t`Export Config`,
                defaultPath: 'rclone.conf',
                filters: [
                    {
                        DisplayName: t({
                            message: 'Rclone config',
                            comment: 'A kind of file in the save dialog: an rclone config file.',
                        }),
                        Pattern: '*.conf',
                    },
                ],
            })
            if (!path) return
            await exportConfig(path)
        },
        onError: onErrorDialog(t`Failed to export config`, undefined, {
            log: ['[exportConfig] failed to export config'],
        }),
    })

    const encryptionMutation = useMutation({
        mutationFn: async ({ action, config }: { action: string; config: ConfigFile }) => {
            switch (action) {
                case 'enable':
                case 'update': {
                    const password = await promptPassword(
                        action === 'enable'
                            ? t`Enter a password to encrypt the config.`
                            : t`Enter a new password for the config.`
                    )
                    if (!password) return
                    const remember = await askToRemember()
                    await setConfigPassword(password, remember)
                    return
                }
                case 'disable': {
                    const confirmed = await ask(
                        t`This will remove the encryption password from the config.`,
                        {
                            title: t`Disable Encryption?`,
                            kind: 'warning',
                            okLabel: t({
                                message: 'Disable',
                                comment: "Button: removes the config's encryption.",
                            }),
                            cancelLabel: t`Cancel`,
                        }
                    )
                    if (confirmed) await removeConfigPassword()
                    return
                }
                case 'save-password': {
                    const password = await promptPassword(
                        t`Enter the current password of the config to save it.`
                    )
                    if (!password) return
                    await rememberConfigPassword(password)
                    await message(t`The password has been saved in the system keychain.`, {
                        title: t`Config Password`,
                    })
                    return
                }
                case 'save-password-command': {
                    const command = await prompt({
                        title: t`Password command`,
                        message: t`Enter a command that prints the config's password (rclone's --password-command).`,
                        default: config.passwordCommand,
                    })
                    if (command === null) return
                    await setPasswordCommand(command.trim())
                    return
                }
                case 'remove-password': {
                    const confirmed = await ask(
                        t`Forget the config's saved password? You will be asked for it next time it's needed.`,
                        {
                            title: t`Remove saved password`,
                            kind: 'warning',
                            destructive: true,
                            okLabel: t({
                                message: 'Remove',
                                comment: "Button: forgets the config's saved password.",
                            }),
                            cancelLabel: t`Cancel`,
                        }
                    )
                    if (!confirmed) return
                    await forgetConfigPassword()
                    if (config.passwordCommand) await setPasswordCommand('')
                    return
                }
                case 'unlock': {
                    await unlockConfig()
                    return
                }
                default:
                    return
            }
        },
        onError: onErrorDialog(t`Config Encryption`),
    })

    return (
        <div className="flex flex-col gap-3">
            {/* Don't show a config that failed to load as missing. */}
            {isError && (
                <Alert
                    color="danger"
                    variant="faded"
                    title={t`The config couldn't be loaded`}
                    endContent={
                        <Button
                            size="sm"
                            variant="flat"
                            className="self-center shrink-0"
                            isLoading={isFetching}
                            onPress={() => refetch()}
                            data-focus-visible="false"
                        >
                            <Trans>Retry</Trans>
                        </Button>
                    }
                >
                    <p className="text-small">{formatErrorMessage(error)}</p>
                </Alert>
            )}
            {config?.saveError && (
                // A save that failed ("not saved: …"), or a password that the keychain
                // refused.
                <Alert color="danger" variant="faded" title={upperFirst(config.saveError)} />
            )}
            {config && (
                <ConfigCard
                    configFile={config}
                    onEncryption={(action) => encryptionMutation.mutate({ action, config })}
                    encryptionPending={encryptionMutation.isPending}
                    onExport={() => exportConfigMutation.mutate()}
                />
            )}
        </div>
    )
}

function ConfigCard({
    configFile,
    onEncryption,
    encryptionPending,
    onExport,
}: {
    configFile: ConfigFile
    onEncryption: (action: string) => void
    encryptionPending: boolean
    onExport: () => void
}) {
    const locked = configFile.status === ConfigStatus.StatusNeedsPassword
    const saved = configFile.passwordSaved || !!configFile.passwordCommand

    const disabledKeys = useMemo(() => {
        if (locked) return ['enable', 'disable', 'update', 'save-password']
        if (!configFile.encrypted) {
            return ['disable', 'update', 'save-password', 'remove-password', 'unlock']
        }
        const disabled = ['enable', 'unlock']
        if (configFile.passwordSaved) disabled.push('save-password')
        if (!saved) disabled.push('remove-password')
        return disabled
    }, [configFile, locked, saved])

    const status = statusOf(configFile, saved)

    return (
        <Panel className="divide-y divide-divider">
            <div className="flex items-center gap-3 px-4 py-3.5">
                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                    <span className="text-xs text-default-500">
                        <Trans comment="Label of the config file's path.">File</Trans>
                    </span>
                    <p className="font-mono truncate text-small" title={configFile.path}>
                        {configFile.path}
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="flat"
                    startContent={<FolderIcon className="size-4" />}
                    onPress={() => revealPath(configFile.path)}
                >
                    <Trans>Show in folder</Trans>
                </Button>
                <Button
                    size="sm"
                    variant="flat"
                    startContent={<DownloadBracketIcon className="size-4" />}
                    onPress={onExport}
                >
                    <Trans comment="Button: saves a copy of the config file.">Export</Trans>
                </Button>
            </div>
            <div className="flex items-center gap-3 px-4 py-3.5">
                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                    <span className="text-xs text-default-500">
                        <Trans comment="Label of the config file's encryption state.">
                            Encryption
                        </Trans>
                    </span>
                    <p
                        className={cn(
                            'flex items-center gap-2 text-small',
                            status.kind === 'danger' && 'text-danger',
                            status.kind === 'warning' && 'text-warning-600 dark:text-warning'
                        )}
                        title={status.detail}
                    >
                        <StatusDot kind={status.kind} />
                        <span className="truncate">{status.label}</span>
                    </p>
                </div>
                <Dropdown>
                    <DropdownTrigger>
                        <Button
                            size="sm"
                            variant="flat"
                            isLoading={encryptionPending}
                            startContent={
                                encryptionPending ? undefined : (
                                    <LockSimpleIcon className="size-4" />
                                )
                            }
                            aria-label={t`Encryption settings`}
                        >
                            {locked
                                ? t({
                                      message: 'Unlock…',
                                      comment: 'Button: opens the menu to unlock the config.',
                                  })
                                : configFile.encrypted
                                  ? t({
                                        message: 'Password…',
                                        comment: "Button: opens the menu of the config's password.",
                                    })
                                  : t({
                                        message: 'Encrypt…',
                                        comment: 'Button: opens the menu to encrypt the config.',
                                    })}
                        </Button>
                    </DropdownTrigger>
                    <DropdownMenu
                        aria-label={t`Encryption settings`}
                        disabledKeys={disabledKeys}
                        onAction={(key) => setTimeout(() => onEncryption(String(key)), 100)}
                    >
                        <DropdownItem key="unlock">
                            {t({
                                message: 'Unlock',
                                comment: 'Menu item: unlocks the encrypted config.',
                            })}
                        </DropdownItem>
                        <DropdownItem key="enable">
                            <Trans>Enable encryption</Trans>
                        </DropdownItem>
                        <DropdownItem key="update">
                            <Trans>Change password</Trans>
                        </DropdownItem>
                        <DropdownItem key="disable">
                            <Trans>Disable encryption</Trans>
                        </DropdownItem>
                        <DropdownItem key="save-password">
                            <Trans comment="Menu item: saves the config's password in the system keychain.">
                                Save password
                            </Trans>
                        </DropdownItem>
                        <DropdownItem key="save-password-command">
                            <Trans comment="Menu item: sets a command that prints the config's password.">
                                Password command
                            </Trans>
                        </DropdownItem>
                        <DropdownItem key="remove-password" color="danger" className="text-danger">
                            <Trans>Remove saved password</Trans>
                        </DropdownItem>
                    </DropdownMenu>
                </Dropdown>
            </div>
        </Panel>
    )
}

function statusOf(
    configFile: ConfigFile,
    saved: boolean
): { kind: StatusKind; label: string; detail?: string } {
    switch (configFile.status) {
        case ConfigStatus.StatusNeedsPassword:
            return { kind: 'danger', label: t`Locked. Enter the password to unlock.` }
        case ConfigStatus.StatusMissing:
            return { kind: 'idle', label: t`Not created yet` }
        case ConfigStatus.StatusError:
            return {
                kind: 'danger',
                label: t({ message: 'Unreadable', comment: 'State of the config file.' }),
                detail: configFile.message,
            }
        default:
            break
    }
    if (!configFile.encrypted) return { kind: 'warning', label: t`Not encrypted` }
    if (configFile.passwordSaved) {
        return { kind: 'success', label: t`Encrypted, password saved in the keychain` }
    }
    if (configFile.passwordCommand) {
        return { kind: 'success', label: t`Encrypted, password from a command` }
    }
    return {
        kind: 'success',
        label: saved
            ? t({ message: 'Encrypted', comment: 'State of the config file.' })
            : t`Encrypted, asks for its password`,
    }
}

/** Capitalizes the first letter of s, because the core's messages start in lowercase. */
function upperFirst(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
}
