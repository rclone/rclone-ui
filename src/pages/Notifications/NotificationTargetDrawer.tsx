import {
    Alert,
    Button,
    Checkbox,
    CheckboxGroup,
    cn,
    Drawer,
    DrawerBody,
    DrawerContent,
    Input,
    Switch,
} from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import {
    ArrowUpRightSquare as ArrowUpRightSquareIcon,
    Check as CheckIcon,
    SendAlt as SendAltIcon,
} from '@zappicon/react'
import { useId, useMemo, useState } from 'react'
import { formatErrorMessage, refusedFields } from '../../../lib/errors'
import {
    addNotificationTarget,
    buildTelegramUrl,
    providerMeta as metaOf,
    type NotificationCatalog,
    type NotificationEvent,
    NotificationProvider,
    type NotificationTarget,
    sendTestNotification,
    splitTelegramUrl,
    TELEGRAM_CHAT_ID_HELP,
    targetSubtitle,
    updateNotificationTarget,
    useSmtp,
    useTargetProblems,
    validateWebhookUrl,
} from '../../../lib/notifications'
import { message, openUrl } from '../../../lib/shell'
import { ProviderTile } from '../../components/icons/ProviderIcon'
import { toneButton } from '../../components/look/buttons'
import { Panel } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { SHEET_COLUMN, SheetFooter, SheetHeader, sheetClass } from '../../components/SettingsWindow'
import { WINDOWS } from '../../routes'
import { rowField } from './fields'

// Fields that can show an error when the core refuses a save. Any other refusal (such as for the
// provider) is shown in a dialog.
const REFUSABLE_FIELDS = ['name', 'url', 'chatId', 'events'] as const
type RefusableField = (typeof REFUSABLE_FIELDS)[number]

const CONNECTION_LINE: Partial<Record<NotificationProvider, string>> & { webhook: string } = {
    [NotificationProvider.NotificationProviderDiscord]: t`A name for this channel, and the webhook URL from the channel's settings.`,
    [NotificationProvider.NotificationProviderSlack]: t`A name for this channel, and the webhook URL from your Slack app.`,
    [NotificationProvider.NotificationProviderTelegram]: t`A name, your bot’s token from BotFather, and the chat it writes to.`,
    [NotificationProvider.NotificationProviderEmail]: t`A name, and the addresses that get the email.`,
    webhook: t`A name, and the URL that gets a JSON post for each event.`,
}

function pickedLine(picked: number, total: number): string {
    if (picked === 0) return t`None picked: nothing is sent.`
    // The same in English, but a language may write "picked" to agree with the number.
    return plural(picked, {
        one: `# of ${total} picked.`,
        other: `# of ${total} picked.`,
    })
}

function pickedOf(picked: number, total: number): string {
    return t({
        message: `${picked} of ${total}`,
        comment: 'How many of the events in a category are picked: "2 of 3".',
    })
}

// One component for both adding and editing. Its state is set from the props when it mounts, so
// the parent gives it a key for each target and provider. The parent renders it only once the
// catalog has loaded, because the event checkboxes come from the catalog. The core checks what is
// saved, and a refusal is shown on the field it applies to.
export default function NotificationTargetDrawer({
    isOpen,
    onClose,
    provider,
    target,
    catalog,
}: {
    isOpen: boolean
    onClose: () => void
    provider: NotificationProvider
    target?: NotificationTarget
    catalog: NotificationCatalog
}) {
    const providerMeta = metaOf(provider)
    const isEditing = !!target
    const isTelegram = provider === NotificationProvider.NotificationProviderTelegram
    // The "url" of an email target holds its recipients. The mail is sent through the saved mail
    // server.
    const isEmail = provider === NotificationProvider.NotificationProviderEmail
    const smtp = useSmtp()
    const smtpMissing = isEmail && !smtp.isLoading && !smtp.data?.host

    const allEventIds = useMemo(() => catalog.events.map((event) => event.id), [catalog])

    const [name, setName] = useState(target?.name ?? '')
    // Telegram stores one combined URL (…/bot<token>/sendMessage?chat_id=…), but the form edits
    // its two parts: the bot token, as BotFather sends it, and the chat id.
    const [url, setUrl] = useState(() =>
        target && isTelegram ? splitTelegramUrl(target.url).token : (target?.url ?? '')
    )
    const [chatId, setChatId] = useState(() =>
        target && isTelegram ? splitTelegramUrl(target.url).chatId : ''
    )
    const [events, setEvents] = useState<NotificationEvent[]>(target?.events ?? allEventIds)
    const [isEnabled, setIsEnabled] = useState(target?.isEnabled ?? true)
    const [urlTouched, setUrlTouched] = useState(false)
    const [chatIdTouched, setChatIdTouched] = useState(false)
    const [justTested, setJustTested] = useState(false)
    // The errors from the core's refusal of the last save, by field. Each one is cleared when its
    // field changes.
    const [refused, setRefused] = useState<Partial<Record<RefusableField, string>>>({})
    const unrefuse = (...fields: RefusableField[]) =>
        setRefused((prev) => {
            if (!fields.some((field) => prev[field])) return prev
            const next = { ...prev }
            for (const field of fields) delete next[field]
            return next
        })

    // The core checks Telegram's bot token and chat ID as the user types, in the URL that they
    // make together. Its errors come back on url (the token) and chatId.
    const telegram = useTargetProblems(
        isTelegram
            ? {
                  provider,
                  name: '',
                  url: buildTelegramUrl(url, chatId),
                  events: [],
                  isEnabled: true,
              }
            : undefined
    )

    // An empty field shows its error once the user has left it, or after Save was pressed.
    const urlError = useMemo(() => {
        if (!urlTouched) {
            return null
        }
        return isTelegram ? (telegram?.url ?? null) : validateWebhookUrl(provider, url)
    }, [provider, isTelegram, url, urlTouched, telegram])

    const chatIdError = isTelegram && chatIdTouched ? (telegram?.chatId ?? null) : null

    // The URL as it will be stored and POSTed. For Telegram it is combined from both parts, once
    // the core takes both.
    const effectiveUrl = useMemo(() => {
        if (!isTelegram) {
            return url.trim()
        }
        if (!telegram || telegram.url || telegram.chatId) {
            return ''
        }
        return buildTelegramUrl(url, chatId)
    }, [isTelegram, url, chatId, telegram])

    const canSendTest =
        !!effectiveUrl && !validateWebhookUrl(provider, effectiveUrl) && !smtpMissing

    const isPlaintextUrl =
        provider === NotificationProvider.NotificationProviderWebhook &&
        url.trim().startsWith('http://')

    const allSelected = events.length === allEventIds.length

    const drawerTitle = isEditing ? providerMeta.editLabel : providerMeta.addLabel

    const sendTestMutation = useMutation({
        mutationFn: async () => {
            await sendTestNotification({
                provider,
                url: effectiveUrl,
                // Pass the saved target only while its URL matches the one here. An edited URL is
                // tested as typed, and the result isn't recorded on the target.
                id: target && effectiveUrl === target.url ? target.id : undefined,
                name: name.trim() || undefined,
            })
        },
        onSuccess: () => {
            setJustTested(true)
            setTimeout(() => setJustTested(false), 2000)
        },
        onError: async (error) => {
            await message(formatErrorMessage(error, t`Unknown error occurred`), {
                title: t`Test failed`,
                kind: 'error',
            })
        },
    })

    const handleSave = async (close: () => void) => {
        setUrlTouched(true)
        setChatIdTouched(true)
        // The core refuses a Telegram target whose token or chat ID is wrong, on the field of
        // that part.
        const fields = {
            provider,
            name: name.trim(),
            url: isTelegram ? buildTelegramUrl(url, chatId) : url.trim(),
            events,
            isEnabled,
        }

        try {
            if (isEditing) {
                await updateNotificationTarget(target.id, fields)
            } else {
                await addNotificationTarget(fields)
            }
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
            await message(formatErrorMessage(error, t`The notification was not saved.`), {
                title: t`Save failed`,
                kind: 'error',
            })
            return
        }

        close()
        onClose()
    }

    const eventsTitleId = useId()
    const enabledId = useId()

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
                            tile={<ProviderTile provider={provider} size="xl" />}
                            title={drawerTitle}
                            description={target ? targetSubtitle(target) : providerMeta.description}
                        />
                        <DrawerBody>
                            <div className={cn(SHEET_COLUMN, 'flex flex-col gap-7 pt-2 pb-4')}>
                                <section className="flex flex-col gap-3">
                                    <SectionTitle
                                        title={t`Connection`}
                                        description={
                                            CONNECTION_LINE[provider] ?? CONNECTION_LINE.webhook
                                        }
                                        actions={
                                            !!providerMeta.helpUrl && (
                                                <Button
                                                    size="sm"
                                                    variant="light"
                                                    color="primary"
                                                    endContent={
                                                        <ArrowUpRightSquareIcon className="size-4" />
                                                    }
                                                    onPress={() => openUrl(providerMeta.helpUrl!)}
                                                    data-focus-visible="false"
                                                >
                                                    {providerMeta.helpLabel}
                                                </Button>
                                            )
                                        }
                                    />
                                    <Panel className="flex flex-col divide-y divide-divider">
                                        <Input
                                            label={t`Name`}
                                            labelPlacement="outside-left"
                                            size="sm"
                                            classNames={rowField('wide')}
                                            placeholder={t`e.g. Team alerts channel`}
                                            value={name}
                                            onValueChange={(value) => {
                                                setName(value)
                                                unrefuse('name')
                                            }}
                                            isRequired={true}
                                            isInvalid={!!refused.name}
                                            errorMessage={refused.name}
                                            autoCapitalize="off"
                                            autoComplete="off"
                                            autoCorrect="off"
                                            spellCheck="false"
                                        />
                                        <Input
                                            label={
                                                isTelegram
                                                    ? t`Bot token`
                                                    : isEmail
                                                      ? t`Send to`
                                                      : t`Webhook URL`
                                            }
                                            labelPlacement="outside-left"
                                            size="sm"
                                            placeholder={providerMeta.urlPlaceholder}
                                            value={url}
                                            onValueChange={(value) => {
                                                setUrl(value)
                                                unrefuse('url')
                                            }}
                                            onBlur={() => setUrlTouched(true)}
                                            isRequired={true}
                                            isInvalid={!!(urlError || refused.url)}
                                            errorMessage={urlError ?? refused.url}
                                            description={
                                                isEmail
                                                    ? t`Separate several addresses with commas.`
                                                    : isPlaintextUrl
                                                      ? t`Unencrypted URL. The webhook payload will be sent in plaintext.`
                                                      : undefined
                                            }
                                            classNames={{
                                                ...rowField('wide'),
                                                input: 'font-mono text-small',
                                            }}
                                            autoCapitalize="off"
                                            autoComplete="off"
                                            autoCorrect="off"
                                            spellCheck="false"
                                            type={isEmail || isTelegram ? 'text' : 'url'}
                                        />
                                        {isTelegram && (
                                            <Input
                                                label={t`Chat ID`}
                                                labelPlacement="outside-left"
                                                size="sm"
                                                placeholder={t({
                                                    message:
                                                        '123456789 or -1001234567890 or @channelname',
                                                    comment:
                                                        'Examples of chat IDs: only the word "or" is translated.',
                                                })}
                                                value={chatId}
                                                onValueChange={(value) => {
                                                    setChatId(value)
                                                    // A refused URL covers both parts, so editing
                                                    // either one clears the error.
                                                    unrefuse('url', 'chatId')
                                                }}
                                                onBlur={() => setChatIdTouched(true)}
                                                isRequired={true}
                                                isInvalid={!!(chatIdError || refused.chatId)}
                                                errorMessage={chatIdError ?? refused.chatId}
                                                description={TELEGRAM_CHAT_ID_HELP}
                                                classNames={{
                                                    ...rowField('wide'),
                                                    input: 'font-mono text-small',
                                                }}
                                                autoCapitalize="off"
                                                autoComplete="off"
                                                autoCorrect="off"
                                                spellCheck="false"
                                            />
                                        )}
                                    </Panel>

                                    {smtpMissing && (
                                        <Alert
                                            color="warning"
                                            variant="faded"
                                            title={t`Set up SMTP first`}
                                        >
                                            <Trans>
                                                Email notifications go out through your mail server.
                                                Save it with the mail button at the top of
                                                Notifications, then test this address.
                                            </Trans>
                                        </Alert>
                                    )}

                                    {isTelegram && (
                                        <Alert
                                            color="primary"
                                            variant="faded"
                                            title={t`Start the bot first`}
                                        >
                                            <Trans comment="Start is the name of the button that Telegram shows in a bot's chat.">
                                                Open your bot in Telegram and tap Start (or send it
                                                any message). Telegram won't let a bot message you
                                                until you do.
                                            </Trans>
                                        </Alert>
                                    )}
                                </section>

                                <section
                                    aria-labelledby={eventsTitleId}
                                    className="flex flex-col gap-3"
                                >
                                    <SectionTitle
                                        id={eventsTitleId}
                                        title={t`Events`}
                                        description={
                                            <span className="tabular-nums">
                                                {pickedLine(events.length, allEventIds.length)}
                                            </span>
                                        }
                                        actions={
                                            <Button
                                                size="sm"
                                                variant="flat"
                                                onPress={() => {
                                                    setEvents(allSelected ? [] : allEventIds)
                                                    unrefuse('events')
                                                }}
                                                data-focus-visible="false"
                                            >
                                                {allSelected ? t`Deselect all` : t`Select all`}
                                            </Button>
                                        }
                                    />
                                    <CheckboxGroup
                                        value={events}
                                        onValueChange={(value) => {
                                            setEvents(value as NotificationEvent[])
                                            unrefuse('events')
                                        }}
                                        isInvalid={!!refused.events}
                                        errorMessage={refused.events}
                                        aria-label={t`Events that send this notification`}
                                        classNames={{ wrapper: 'gap-0' }}
                                    >
                                        <Panel className="flex flex-col divide-y divide-divider">
                                            {catalog.categories.map((category) => {
                                                const inside = catalog.events.filter(
                                                    (event) => event.category === category.id
                                                )
                                                const picked = inside.filter((event) =>
                                                    events.includes(event.id)
                                                ).length
                                                return (
                                                    <div
                                                        key={category.id}
                                                        className="flex flex-col gap-1 px-5 pt-3.5 pb-4"
                                                    >
                                                        <p className="flex items-baseline justify-between gap-3 pb-1 font-medium text-small text-default-600">
                                                            {category.label}
                                                            <span className="text-xs font-normal text-default-400 tabular-nums">
                                                                {pickedOf(picked, inside.length)}
                                                            </span>
                                                        </p>
                                                        {inside.map((event) => (
                                                            <Checkbox
                                                                key={event.id}
                                                                value={event.id}
                                                                classNames={{
                                                                    base: 'max-w-none w-full m-0 py-1.5 items-start',
                                                                    wrapper: 'mt-0.5',
                                                                }}
                                                            >
                                                                <span className="flex flex-col gap-0.5">
                                                                    <span className="leading-snug text-small">
                                                                        {event.label}
                                                                    </span>
                                                                    <span className="text-xs leading-snug text-default-500 text-pretty">
                                                                        {event.description}
                                                                    </span>
                                                                </span>
                                                            </Checkbox>
                                                        ))}
                                                    </div>
                                                )
                                            })}
                                        </Panel>
                                    </CheckboxGroup>
                                </section>

                                <Panel className="flex flex-row items-center gap-6 px-4 py-3">
                                    <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                                        <span id={enabledId} className="font-medium text-small">
                                            <Trans comment="Title of the switch that turns a notification target on or off.">
                                                Enabled
                                            </Trans>
                                        </span>
                                        <span className="text-xs leading-relaxed text-default-500">
                                            {isEmail
                                                ? t`Deliver notifications to these addresses`
                                                : t`Deliver notifications to this webhook`}
                                        </span>
                                    </div>
                                    <Switch
                                        size="sm"
                                        color="primary"
                                        isSelected={isEnabled}
                                        onValueChange={setIsEnabled}
                                        aria-labelledby={enabledId}
                                        data-focus-visible="false"
                                        classNames={{ wrapper: 'me-0' }}
                                    />
                                </Panel>
                            </div>
                        </DrawerBody>
                        <SheetFooter
                            start={
                                <Button
                                    variant="flat"
                                    isLoading={sendTestMutation.isPending}
                                    isDisabled={!canSendTest}
                                    startContent={
                                        sendTestMutation.isPending ? undefined : justTested ? (
                                            <CheckIcon className="size-4 text-success" />
                                        ) : (
                                            <SendAltIcon className="size-4" />
                                        )
                                    }
                                    onPress={() => sendTestMutation.mutate()}
                                    data-focus-visible="false"
                                >
                                    {justTested
                                        ? t({
                                              message: 'Sent',
                                              comment: 'A test notification was sent.',
                                          })
                                        : t`Send test`}
                                </Button>
                            }
                        >
                            <Button
                                variant="flat"
                                onPress={() => {
                                    close()
                                    onClose()
                                }}
                                data-focus-visible="false"
                            >
                                <Trans>Cancel</Trans>
                            </Button>
                            <Button
                                color="primary"
                                className={toneButton(WINDOWS.notifications.tone)}
                                onPress={() => handleSave(close)}
                                data-focus-visible="false"
                            >
                                {isEditing ? t`Save changes` : providerMeta.addLabel}
                            </Button>
                        </SheetFooter>
                        <span role="status" className="sr-only">
                            {justTested ? t`Test sent` : ''}
                        </span>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
