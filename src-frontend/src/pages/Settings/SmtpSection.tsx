import { Button, Input, Select, SelectItem } from '@heroui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { message } from '../../../lib/api/dialog'
import { useIsDesktop } from '../../../lib/api/host'
import { useSession } from '../../../lib/api/session'
import { notify } from '../../../lib/notifications'
import { SMTP_QUERY_KEY, saveSmtpSettings, sendSmtpTest, useSmtpSettings } from '../../../lib/smtp'
import type { SmtpEncryption, SmtpView } from '../../../types/smtp'
import BaseSection from './BaseSection'
import SettingsGroup from './SettingsGroup'

const RE_WHOLE_NUMBER = /^\d+$/

const ENCRYPTION: { key: SmtpEncryption; label: string }[] = [
    { key: 'starttls', label: 'STARTTLS' },
    { key: 'tls', label: 'SSL / TLS' },
    { key: 'none', label: 'None' },
]

interface Draft {
    host: string
    port: string
    encryption: SmtpEncryption
    username: string
    /** Never filled in from the server; empty means "keep what is saved". */
    password: string
    fromAddress: string
    fromName: string
}

const EMPTY: Draft = {
    host: '',
    port: '',
    encryption: 'starttls',
    username: '',
    password: '',
    fromAddress: '',
    fromName: '',
}

function draftOf(view: SmtpView): Draft {
    return {
        host: view.host,
        port: view.port ? String(view.port) : '',
        encryption: view.encryption || 'starttls',
        username: view.username,
        password: '',
        fromAddress: view.fromAddress,
        fromName: view.fromName,
    }
}

// The mail server every Email notification goes through (the server's own file, read at send
// time by whatever dispatches, the scheduled runner included). The password is write-only: the
// form never gets it back, only that one is saved.
export default function SmtpSection() {
    const layout = useIsDesktop() ? 'native' : 'web'
    const queryClient = useQueryClient()
    const settingsQuery = useSmtpSettings()
    const session = useSession()

    const [draft, setDraft] = useState(EMPTY)
    const [testTo, setTestTo] = useState('')
    const set = (key: keyof Draft) => (value: string) =>
        setDraft((previous) => ({ ...previous, [key]: value }))

    // The saved settings seed the form once they arrive; what is typed afterwards stays.
    const saved = settingsQuery.data
    useEffect(() => {
        if (saved) setDraft(draftOf(saved))
    }, [saved])
    const signedInAs = session.data?.user?.email
    useEffect(() => {
        if (signedInAs) setTestTo((current) => current || signedInAs)
    }, [signedInAs])

    const hasPassword = !!saved?.hasPassword
    const isConfigured = !!saved?.host

    const saveMutation = useMutation({
        mutationFn: () =>
            saveSmtpSettings({
                host: draft.host.trim(),
                // Anything but a whole number is 0, which the server refuses by name.
                port: RE_WHOLE_NUMBER.test(draft.port.trim()) ? Number(draft.port.trim()) : 0,
                encryption: draft.encryption,
                username: draft.username.trim(),
                password: draft.password ? draft.password : null,
                fromAddress: draft.fromAddress.trim(),
                fromName: draft.fromName.trim(),
            }),
        onSuccess: async (view) => {
            queryClient.setQueryData(SMTP_QUERY_KEY, view)
            setDraft(draftOf(view))
            await notify({
                title: 'SMTP settings saved',
                body: view.host
                    ? `Email notifications go out through ${view.host}.`
                    : 'No mail server is set; email notifications are not sent.',
            })
        },
        onError: async (error) => {
            await message(error instanceof Error ? error.message : String(error), {
                title: 'Unable to save',
                kind: 'error',
            })
        },
    })

    const testMutation = useMutation({
        mutationFn: () => sendSmtpTest(testTo.trim()),
        onSuccess: async () => {
            await notify({
                title: 'Test email sent',
                body: `A test email went to ${testTo.trim()}.`,
            })
        },
        onError: async (error) => {
            await message(error instanceof Error ? error.message : String(error), {
                title: 'Test failed',
                kind: 'error',
            })
        },
    })

    return (
        <BaseSection
            header={{ title: 'SMTP' }}
            className={layout === 'web' ? 'w-full max-w-3xl gap-4 px-6 pb-12 mx-auto' : 'pb-12'}
        >
            <SettingsGroup
                layout={layout}
                title="Server"
                description="The mail server this Rclone UI sends email notifications through."
            >
                <Input
                    label="Host"
                    placeholder="smtp.example.com"
                    value={draft.host}
                    onValueChange={set('host')}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                />
                <div className="flex flex-row gap-3">
                    <Input
                        label="Port"
                        placeholder="587"
                        value={draft.port}
                        onValueChange={set('port')}
                        inputMode="numeric"
                        className="w-1/3"
                        autoComplete="off"
                    />
                    <Select
                        label="Encryption"
                        selectedKeys={[draft.encryption]}
                        disallowEmptySelection={true}
                        onSelectionChange={(keys) =>
                            set('encryption')(String(Array.from(keys)[0] ?? 'starttls'))
                        }
                        data-focus-visible="false"
                    >
                        {ENCRYPTION.map((option) => (
                            <SelectItem key={option.key}>{option.label}</SelectItem>
                        ))}
                    </Select>
                </div>
            </SettingsGroup>

            <SettingsGroup
                layout={layout}
                title="Credentials"
                description="Left empty for a server that accepts unauthenticated relays."
            >
                <Input
                    label="Username"
                    value={draft.username}
                    onValueChange={set('username')}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                />
                <Input
                    label="Password"
                    type="password"
                    placeholder={hasPassword ? 'Saved — leave empty to keep it' : undefined}
                    value={draft.password}
                    onValueChange={set('password')}
                    autoComplete="off"
                />
            </SettingsGroup>

            <SettingsGroup
                layout={layout}
                title="Sender"
                description="What the people you mail will see it come from."
            >
                <Input
                    label="From address"
                    placeholder="rclone-ui@example.com"
                    value={draft.fromAddress}
                    onValueChange={set('fromAddress')}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                />
                <Input
                    label="From name"
                    placeholder="Rclone UI"
                    value={draft.fromName}
                    onValueChange={set('fromName')}
                />
                <Button
                    color="primary"
                    className="self-start"
                    isLoading={saveMutation.isPending}
                    onPress={() => saveMutation.mutate()}
                    data-focus-visible="false"
                >
                    Save
                </Button>
            </SettingsGroup>

            <SettingsGroup
                layout={layout}
                title="Test"
                description={
                    isConfigured
                        ? 'One message through the saved settings, to make sure they work.'
                        : 'Save a server first, then send a message through it.'
                }
            >
                <div className="flex flex-row items-end gap-3">
                    <Input
                        label="Send a test to"
                        placeholder="you@example.com"
                        value={testTo}
                        onValueChange={setTestTo}
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                    />
                    <Button
                        variant="flat"
                        className="shrink-0"
                        isLoading={testMutation.isPending}
                        isDisabled={!isConfigured || !testTo.trim()}
                        onPress={() => testMutation.mutate()}
                        data-focus-visible="false"
                    >
                        Send test email
                    </Button>
                </div>
            </SettingsGroup>
        </BaseSection>
    )
}
