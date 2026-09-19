import {
    Alert,
    Button,
    Checkbox,
    CheckboxGroup,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
    Switch,
    cn,
} from '@heroui/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { ExternalLinkIcon, SettingsIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
    NOTIFICATION_PROVIDERS,
    TELEGRAM_CHAT_ID_HELP,
    addNotificationTarget,
    buildTelegramUrl,
    sendTestNotification,
    splitTelegramUrl,
    updateNotificationTarget,
    validateTelegramBotUrl,
    validateTelegramChatId,
    validateWebhookUrl,
} from '../../lib/notifications'
import { isSmtpConfigured, useSmtpSettings } from '../../lib/smtp'
import type {
    NotificationCatalog,
    NotificationEventId,
    NotificationProvider,
    NotificationTarget,
} from '../../types/notifications'
import ProviderIcon from './icons/ProviderIcon'
import { message } from '../../lib/api/dialog'
import { openUrl } from '../../lib/api/shell'
import { navigate } from '../../lib/api/navigation'

// Single component for both add and edit — the forms are identical, only the header text,
// initial values, and the Rust command differ. State seeds from props at mount: the parent
// remounts this with a key per target/provider, and only renders it once the catalog query
// has data (the checkbox list derives from it).
export default function NotificationTargetDrawer({
    isOpen,
    onClose,
    provider,
    target,
    catalog,
    existingTargets,
}: {
    isOpen: boolean
    onClose: () => void
    provider: NotificationProvider
    target?: NotificationTarget
    catalog: NotificationCatalog
    existingTargets: NotificationTarget[]
}) {
    const providerMeta = NOTIFICATION_PROVIDERS[provider]
    const isEditing = !!target
    const isTelegram = provider === 'telegram'
    // An email target's "url" is its recipients; what sends it is the SMTP screen's server.
    const isEmail = provider === 'email'
    const smtpQuery = useSmtpSettings()
    const smtpMissing = isEmail && smtpQuery.isSuccess && !isSmtpConfigured(smtpQuery.data)

    const queryClient = useQueryClient()

    const allEventIds = useMemo(() => catalog.events.map((event) => event.id), [catalog])

    const [name, setName] = useState(target?.name ?? '')
    // Telegram stores one merged URL (…/sendMessage?chat_id=…) but the form edits its two
    // halves separately — the user never types query params by hand.
    const [url, setUrl] = useState(() =>
        target && isTelegram ? splitTelegramUrl(target.url).baseUrl : (target?.url ?? '')
    )
    const [chatId, setChatId] = useState(() =>
        target && isTelegram ? splitTelegramUrl(target.url).chatId : ''
    )
    const [events, setEvents] = useState<NotificationEventId[]>(target?.events ?? allEventIds)
    const [isEnabled, setIsEnabled] = useState(target?.isEnabled ?? true)
    const [urlTouched, setUrlTouched] = useState(false)
    const [chatIdTouched, setChatIdTouched] = useState(false)
    const [justTested, setJustTested] = useState(false)

    const urlError = useMemo(() => {
        if (!urlTouched || !url.trim()) {
            return null
        }
        return isTelegram ? validateTelegramBotUrl(url) : validateWebhookUrl(provider, url)
    }, [provider, isTelegram, url, urlTouched])

    const chatIdError = useMemo(
        () =>
            isTelegram && chatIdTouched && chatId.trim() ? validateTelegramChatId(chatId) : null,
        [isTelegram, chatId, chatIdTouched]
    )

    // The URL as it will be stored and POSTed — merged for Telegram, as typed otherwise.
    const effectiveUrl = useMemo(() => {
        if (!isTelegram) {
            return url.trim()
        }
        if (validateTelegramBotUrl(url) || validateTelegramChatId(chatId)) {
            return ''
        }
        return buildTelegramUrl(url, chatId)
    }, [isTelegram, url, chatId])

    const canSendTest =
        !!effectiveUrl && !validateWebhookUrl(provider, effectiveUrl) && !smtpMissing

    const isPlaintextUrl = provider === 'webhook' && url.trim().startsWith('http://')

    const allSelected = events.length === allEventIds.length

    const drawerTitle = `${isEditing ? 'Edit' : 'Add'} ${providerMeta.titleLabel}`

    const sendTestMutation = useMutation({
        mutationFn: async () => {
            await sendTestNotification({
                provider,
                url: effectiveUrl,
                id: target?.id,
                name: name.trim() || undefined,
            })
        },
        onSuccess: () => {
            setJustTested(true)
            setTimeout(() => setJustTested(false), 2000)
        },
        onError: async (error) => {
            await message(error instanceof Error ? error.message : 'Unknown error occurred', {
                title: 'Test failed',
                kind: 'error',
            })
        },
        // A saved target gets its outcome recorded in Rust — refresh the list's chips.
        onSettled: () => queryClient.invalidateQueries({ queryKey: ['notifications', 'targets'] }),
    })

    const handleSave = async (close: () => void) => {
        const trimmedName = name.trim()

        if (!trimmedName || !url.trim() || (isTelegram && !chatId.trim())) {
            await message(
                isTelegram
                    ? 'Name, bot URL and chat ID are required.'
                    : isEmail
                      ? 'Name and at least one address are required.'
                      : 'Name and webhook URL are required.',
                {
                    title: 'Missing information',
                    kind: 'warning',
                }
            )
            return
        }

        if (isTelegram) {
            const fieldError = validateTelegramBotUrl(url) || validateTelegramChatId(chatId)
            if (fieldError) {
                await message(fieldError, {
                    title: 'Invalid Telegram configuration',
                    kind: 'warning',
                })
                return
            }
        }

        const mergedUrl = isTelegram ? buildTelegramUrl(url, chatId) : url.trim()

        const validationError = validateWebhookUrl(provider, mergedUrl)
        if (validationError) {
            await message(validationError, {
                title: isEmail ? 'Check the addresses' : 'Invalid webhook URL',
                kind: 'warning',
            })
            return
        }

        // Early feedback from this window's snapshot — Rust re-checks race-safely on save.
        const duplicateUrl = existingTargets.some(
            (existing) =>
                existing.id !== target?.id &&
                existing.url.trim().toLowerCase() === mergedUrl.toLowerCase()
        )
        if (duplicateUrl) {
            await message(
                isEmail
                    ? 'An email notification to these addresses is already configured.'
                    : 'A webhook with this URL is already configured.',
                {
                    title: isEmail ? 'Duplicate addresses' : 'Duplicate webhook',
                    kind: 'warning',
                }
            )
            return
        }

        if (events.length === 0) {
            await message(
                `Select at least one event. To keep ${isEmail ? 'these addresses' : 'this webhook'} without notifications, use the Enabled switch instead.`,
                {
                    title: 'No events selected',
                    kind: 'warning',
                }
            )
            return
        }

        try {
            if (isEditing) {
                await updateNotificationTarget(target.id, {
                    name: trimmedName,
                    url: mergedUrl,
                    events,
                    isEnabled,
                })
            } else {
                await addNotificationTarget({
                    provider,
                    name: trimmedName,
                    url: mergedUrl,
                    events,
                    isEnabled,
                })
            }
        } catch (error) {
            await message(error instanceof Error ? error.message : String(error), {
                title: 'Save failed',
                kind: 'error',
            })
            return
        }

        await queryClient.invalidateQueries({ queryKey: ['notifications', 'targets'] })
        close()
        onClose()
    }

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
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
                        <DrawerHeader className="flex items-center gap-2">
                            <ProviderIcon
                                provider={provider}
                                className={cn('size-5', providerMeta.accentClass)}
                            />
                            <span>{drawerTitle}</span>
                        </DrawerHeader>
                        <DrawerBody>
                            <div className="flex flex-col gap-8">
                                <section className="flex flex-col gap-4">
                                    <Input
                                        label="Name"
                                        labelPlacement="outside"
                                        placeholder="e.g. Team alerts channel"
                                        value={name}
                                        onValueChange={setName}
                                        isRequired={true}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />
                                    <Input
                                        label={
                                            isTelegram
                                                ? 'Bot URL'
                                                : isEmail
                                                  ? 'Send to'
                                                  : 'Webhook URL'
                                        }
                                        labelPlacement="outside"
                                        placeholder={providerMeta.urlPlaceholder}
                                        value={url}
                                        onValueChange={setUrl}
                                        onBlur={() => setUrlTouched(true)}
                                        isRequired={true}
                                        isInvalid={!!urlError}
                                        errorMessage={urlError}
                                        description={
                                            isEmail
                                                ? 'Separate several addresses with commas.'
                                                : isPlaintextUrl
                                                  ? 'Unencrypted URL — the webhook payload will be sent in plaintext.'
                                                  : undefined
                                        }
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                        type={isEmail ? 'text' : 'url'}
                                    />
                                    {isTelegram && (
                                        <Input
                                            label="Chat ID"
                                            labelPlacement="outside"
                                            placeholder="123456789 or -1001234567890 or @channelname"
                                            value={chatId}
                                            onValueChange={setChatId}
                                            onBlur={() => setChatIdTouched(true)}
                                            isRequired={true}
                                            isInvalid={!!chatIdError}
                                            errorMessage={chatIdError}
                                            description={TELEGRAM_CHAT_ID_HELP}
                                            autoCapitalize="off"
                                            autoComplete="off"
                                            autoCorrect="off"
                                            spellCheck="false"
                                        />
                                    )}
                                </section>

                                {!!providerMeta.helpUrl && (
                                    <Button
                                        fullWidth={true}
                                        variant="flat"
                                        startContent={<ExternalLinkIcon className="w-4 h-4" />}
                                        onPress={() => openUrl(providerMeta.helpUrl!)}
                                        data-focus-visible="false"
                                    >
                                        {providerMeta.helpLabel}
                                    </Button>
                                )}

                                {isTelegram && (
                                    <Alert
                                        color="primary"
                                        variant="faded"
                                        title="Start the bot first"
                                    >
                                        Open your bot in Telegram and tap Start (or send it any
                                        message). Telegram won't let a bot message you until you do.
                                    </Alert>
                                )}

                                {smtpMissing && (
                                    <Alert
                                        color="warning"
                                        variant="faded"
                                        title="Set up SMTP first"
                                        endContent={
                                            <Button
                                                size="sm"
                                                variant="flat"
                                                color="warning"
                                                startContent={<SettingsIcon className="w-4 h-4" />}
                                                onPress={() => navigate('/settings/smtp')}
                                                data-focus-visible="false"
                                            >
                                                Open SMTP settings
                                            </Button>
                                        }
                                    >
                                        Email notifications go out through the mail server saved
                                        under Settings → SMTP. You can add this one now; nothing is
                                        sent until a server is saved.
                                    </Alert>
                                )}

                                <section className="flex flex-col gap-4">
                                    <div className="flex items-center justify-between">
                                        <p className="text-sm font-semibold uppercase text-default-500">
                                            Events
                                        </p>
                                        <Button
                                            size="sm"
                                            variant="light"
                                            onPress={() =>
                                                setEvents(allSelected ? [] : allEventIds)
                                            }
                                            data-focus-visible="false"
                                        >
                                            {allSelected ? 'Deselect all' : 'Select all'}
                                        </Button>
                                    </div>
                                    <CheckboxGroup
                                        value={events}
                                        onValueChange={(value) =>
                                            setEvents(value as NotificationEventId[])
                                        }
                                        aria-label="Events that trigger this webhook"
                                    >
                                        <div className="flex flex-col gap-6">
                                            {catalog.categories.map((category) => (
                                                <div
                                                    key={category.id}
                                                    className="flex flex-col gap-2"
                                                >
                                                    <p className="text-xs font-semibold uppercase text-default-400">
                                                        {category.label}
                                                    </p>
                                                    {catalog.events
                                                        .filter(
                                                            (event) =>
                                                                event.category === category.id
                                                        )
                                                        .map((event) => (
                                                            <Checkbox
                                                                key={event.id}
                                                                value={event.id}
                                                            >
                                                                <div className="flex flex-col">
                                                                    <span className="text-small">
                                                                        {event.label}
                                                                    </span>
                                                                    <span className="text-tiny text-default-400">
                                                                        {event.description}
                                                                    </span>
                                                                </div>
                                                            </Checkbox>
                                                        ))}
                                                </div>
                                            ))}
                                        </div>
                                    </CheckboxGroup>
                                </section>

                                <section className="flex flex-col gap-4">
                                    <Switch
                                        size="sm"
                                        color="primary"
                                        isSelected={isEnabled}
                                        onValueChange={setIsEnabled}
                                        data-focus-visible="false"
                                    >
                                        <div className="flex flex-col">
                                            <span className="text-small">Enabled</span>
                                            <span className="text-tiny text-default-400">
                                                {isEmail
                                                    ? 'Deliver notifications to these addresses'
                                                    : 'Deliver notifications to this webhook'}
                                            </span>
                                        </div>
                                    </Switch>
                                </section>
                            </div>
                        </DrawerBody>
                        <DrawerFooter>
                            <Button
                                className="mr-auto"
                                variant="faded"
                                color="primary"
                                isLoading={sendTestMutation.isPending}
                                isDisabled={!canSendTest}
                                onPress={() => sendTestMutation.mutate()}
                                data-focus-visible="false"
                            >
                                {justTested ? 'Sent ✓' : 'Send Test'}
                            </Button>
                            <Button
                                color="danger"
                                variant="light"
                                onPress={() => {
                                    close()
                                    onClose()
                                }}
                                data-focus-visible="false"
                            >
                                Cancel
                            </Button>
                            <Button
                                color="primary"
                                onPress={() => handleSave(close)}
                                data-focus-visible="false"
                            >
                                {isEditing ? 'Save Changes' : `Add ${providerMeta.titleLabel}`}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
