import {
    Button,
    cn,
    Drawer,
    DrawerBody,
    DrawerContent,
    Input,
    Select,
    SelectItem,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { SendAlt as SendAltIcon } from '@zappicon/react'
import { useEffect, useState } from 'react'
import { formatErrorMessage, refusedFields } from '../../../lib/errors'
import {
    NotificationProvider,
    SMTPEncryption,
    type SMTPView,
    saveSmtp,
    testSmtp,
    useSmtp,
} from '../../../lib/notifications'
import { message } from '../../../lib/shell'
import { ProviderTile } from '../../components/icons/ProviderIcon'
import { toneButton } from '../../components/look/buttons'
import { StatusDot } from '../../components/look/Status'
import { SHEET_COLUMN, SheetFooter, SheetHeader, sheetClass } from '../../components/SettingsWindow'
import { WINDOWS } from '../../routes'

import { FieldGroup, rowField } from './fields'

const RE_WHOLE_NUMBER = /^\d+$/

const ENCRYPTION: { key: SMTPEncryption; label: string }[] = [
    { key: SMTPEncryption.SMTPEncryptionStartTLS, label: 'STARTTLS' },
    { key: SMTPEncryption.SMTPEncryptionTLS, label: 'SSL / TLS' },
    {
        key: SMTPEncryption.SMTPEncryptionNone,
        label: t({ message: 'None', comment: "A mail server's encryption: no encryption." }),
    },
]

// Fields that can show an error when the core refuses a save. Any other refusal is shown in a
// dialog.
const REFUSABLE_FIELDS = ['port', 'encryption', 'fromAddress'] as const
type RefusableField = (typeof REFUSABLE_FIELDS)[number]

interface Draft {
    host: string
    port: string
    encryption: SMTPEncryption
    username: string
    /** Never filled in from the core. Empty means "keep the saved password". */
    password: string
    fromAddress: string
    fromName: string
}

function sentThrough(host: string, port: number | undefined): string {
    const server = port ? `${host}:${port}` : host
    return t`Email notifications go out through ${server}.`
}

function draftOf(view: SMTPView | undefined): Draft {
    return {
        host: view?.host ?? '',
        port: view?.port ? String(view.port) : '',
        encryption: view?.encryption || SMTPEncryption.SMTPEncryptionStartTLS,
        username: view?.username ?? '',
        password: '',
        fromAddress: view?.fromAddress ?? '',
        fromName: view?.fromName ?? '',
    }
}

// The mail server that every Email notification goes through. The core reads it at the moment of
// sending. The password is write-only: it goes to the keychain, and the form only learns whether
// one is saved (`hasPassword`).
export default function SmtpDrawer({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const smtp = useSmtp()
    const saved = smtp.data
    const [draft, setDraft] = useState(() => draftOf(saved))
    const [testTo, setTestTo] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const [isTesting, setIsTesting] = useState(false)
    // The errors from the core's refusal of the last save, by field. Each one is cleared when its
    // field changes.
    const [refused, setRefused] = useState<Partial<Record<RefusableField, string>>>({})
    const set = (key: keyof Draft) => (value: string) => {
        setDraft((previous) => ({ ...previous, [key]: value }))
        setRefused((previous) => {
            if (!(key in previous)) return previous
            const next = { ...previous }
            delete next[key as RefusableField]
            return next
        })
    }

    // The saved settings fill the form each time the drawer opens, and again when they change
    // (after a save in this or another window). What the user typed stays while they don't
    // change. They are compared by value, because every refetch returns a new object.
    const savedKey = JSON.stringify(draftOf(saved))
    useEffect(() => {
        if (!isOpen) return
        setDraft(JSON.parse(savedKey) as Draft)
        setRefused({})
    }, [isOpen, savedKey])

    const hasPassword = !!saved?.hasPassword
    const isConfigured = !!saved?.host

    const save = async () => {
        setIsSaving(true)
        try {
            const host = draft.host.trim()
            await saveSmtp({
                host,
                // Anything other than a whole number is sent as 0, which the core refuses with
                // the field's name.
                port: RE_WHOLE_NUMBER.test(draft.port.trim()) ? Number(draft.port.trim()) : 0,
                encryption: draft.encryption,
                username: draft.username.trim(),
                password: draft.password,
                fromAddress: draft.fromAddress.trim(),
                fromName: draft.fromName.trim(),
            })
            setDraft((previous) => ({ ...previous, password: '' }))
            await message(
                host
                    ? sentThrough(host, undefined)
                    : t`No mail server is set. Email notifications are not sent.`,
                { title: t`Mail server saved`, kind: 'info' }
            )
            onClose()
        } catch (error) {
            const all = refusedFields(error)
            const onFields: Partial<Record<RefusableField, string>> = {}
            for (const field of REFUSABLE_FIELDS) {
                if (all[field]) onFields[field] = all[field]
            }
            if (Object.keys(onFields).length > 0) {
                setRefused(onFields)
                return
            }
            await message(formatErrorMessage(error), { title: t`Unable to save`, kind: 'error' })
        } finally {
            setIsSaving(false)
        }
    }

    const test = async () => {
        setIsTesting(true)
        try {
            // The core's message comes in the app's language.
            const sent = await testSmtp(testTo.trim())
            await message(sent || t`Test email sent.`, { title: t`Test email sent`, kind: 'info' })
        } catch (error) {
            await message(formatErrorMessage(error), { title: t`Test failed`, kind: 'error' })
        } finally {
            setIsTesting(false)
        }
    }

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent className={sheetClass()}>
                {(close) => (
                    <>
                        <SheetHeader
                            tile={
                                <ProviderTile
                                    provider={NotificationProvider.NotificationProviderEmail}
                                    size="xl"
                                />
                            }
                            title={t`Mail server`}
                            description={
                                <span className="flex items-center min-w-0 gap-2">
                                    <StatusDot kind={isConfigured ? 'success' : 'idle'} />
                                    <span className="truncate">
                                        {isConfigured
                                            ? sentThrough(saved?.host ?? '', saved?.port)
                                            : t`Not set up yet. Email notifications need one.`}
                                    </span>
                                </span>
                            }
                        />
                        <DrawerBody>
                            <div className={cn(SHEET_COLUMN, 'flex flex-col gap-7 pt-2 pb-4')}>
                                <FieldGroup
                                    title={t({
                                        message: 'Server',
                                        comment:
                                            'Title of the part of the form about the mail server.',
                                    })}
                                    description={t`The mail server Rclone UI sends email notifications through`}
                                >
                                    <Input
                                        label={t`Host`}
                                        labelPlacement="outside-left"
                                        size="sm"
                                        placeholder="smtp.example.com"
                                        value={draft.host}
                                        onValueChange={set('host')}
                                        classNames={rowField()}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />
                                    <Input
                                        label={t`Port`}
                                        labelPlacement="outside-left"
                                        size="sm"
                                        placeholder="587"
                                        value={draft.port}
                                        onValueChange={set('port')}
                                        inputMode="numeric"
                                        classNames={{
                                            ...rowField('medium'),
                                            input: 'tabular-nums',
                                        }}
                                        autoComplete="off"
                                        isInvalid={!!refused.port}
                                        errorMessage={refused.port}
                                    />
                                    <Select
                                        label={t`Encryption`}
                                        labelPlacement="outside-left"
                                        size="sm"
                                        selectedKeys={[draft.encryption]}
                                        disallowEmptySelection={true}
                                        isInvalid={!!refused.encryption}
                                        errorMessage={refused.encryption}
                                        onSelectionChange={(keys) =>
                                            set('encryption')(
                                                String(
                                                    Array.from(keys)[0] ??
                                                        SMTPEncryption.SMTPEncryptionStartTLS
                                                )
                                            )
                                        }
                                        classNames={rowField('medium')}
                                        data-focus-visible="false"
                                    >
                                        {ENCRYPTION.map((option) => (
                                            <SelectItem key={option.key}>{option.label}</SelectItem>
                                        ))}
                                    </Select>
                                </FieldGroup>

                                <FieldGroup
                                    title={t`Credentials`}
                                    description={t`Leave empty for a server that accepts unauthenticated relays`}
                                >
                                    <Input
                                        label={t`Username`}
                                        labelPlacement="outside-left"
                                        size="sm"
                                        value={draft.username}
                                        onValueChange={set('username')}
                                        classNames={rowField()}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />
                                    <Input
                                        label={t`Password`}
                                        labelPlacement="outside-left"
                                        size="sm"
                                        type="password"
                                        placeholder={
                                            hasPassword
                                                ? t`Saved — leave empty to keep it`
                                                : undefined
                                        }
                                        value={draft.password}
                                        onValueChange={set('password')}
                                        classNames={rowField()}
                                        autoComplete="off"
                                    />
                                </FieldGroup>

                                <FieldGroup
                                    title={t`Sender`}
                                    description={t`What the people you mail will see it come from`}
                                >
                                    <Input
                                        label={t`From address`}
                                        labelPlacement="outside-left"
                                        size="sm"
                                        placeholder="rclone-ui@example.com"
                                        value={draft.fromAddress}
                                        onValueChange={set('fromAddress')}
                                        isInvalid={!!refused.fromAddress}
                                        errorMessage={refused.fromAddress}
                                        classNames={rowField()}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />
                                    <Input
                                        label={t`From name`}
                                        labelPlacement="outside-left"
                                        size="sm"
                                        placeholder="Rclone UI"
                                        value={draft.fromName}
                                        onValueChange={set('fromName')}
                                        classNames={rowField()}
                                    />
                                </FieldGroup>

                                <FieldGroup
                                    title={t({
                                        message: 'Test',
                                        comment:
                                            'Title of the part of the form that sends a test email.',
                                    })}
                                    description={
                                        isConfigured
                                            ? t`One message through the saved settings, to make sure they work`
                                            : t`Save a server first, then send a message through it`
                                    }
                                >
                                    <div className="flex flex-row items-start gap-2 pr-4">
                                        <Input
                                            label={t`Send a test to`}
                                            labelPlacement="outside-left"
                                            size="sm"
                                            placeholder="you@example.com"
                                            value={testTo}
                                            onValueChange={setTestTo}
                                            classNames={{
                                                ...rowField('wide'),
                                                base: 'flex-row items-start flex-1 min-w-0 gap-x-6 py-2.5 pl-4',
                                            }}
                                            autoCapitalize="off"
                                            autoComplete="off"
                                            autoCorrect="off"
                                            spellCheck="false"
                                        />
                                        <Button
                                            variant="flat"
                                            size="sm"
                                            className="mt-2.5 shrink-0"
                                            startContent={
                                                isTesting ? undefined : (
                                                    <SendAltIcon className="size-4" />
                                                )
                                            }
                                            isLoading={isTesting}
                                            isDisabled={!isConfigured || !testTo.trim()}
                                            onPress={test}
                                            data-focus-visible="false"
                                        >
                                            <Trans>Send test email</Trans>
                                        </Button>
                                    </div>
                                </FieldGroup>
                            </div>
                        </DrawerBody>
                        <SheetFooter>
                            <Button variant="flat" onPress={close} data-focus-visible="false">
                                <Trans>Cancel</Trans>
                            </Button>
                            <Button
                                color="primary"
                                className={toneButton(WINDOWS.notifications.tone)}
                                isLoading={isSaving}
                                onPress={save}
                                data-focus-visible="false"
                            >
                                <Trans>Save</Trans>
                            </Button>
                        </SheetFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
