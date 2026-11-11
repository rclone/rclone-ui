import {
    Autocomplete,
    AutocompleteItem,
    Button,
    cn,
    Drawer,
    DrawerBody,
    DrawerContent,
    Input,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { ArrowsRotate as ArrowsRotateIcon, Cloud as CloudIcon } from '@zappicon/react'
import { type Key, startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { formatErrorMessage, refusedFields } from '../../../lib/errors'
import { followSession, sessionFailure } from '../../../lib/reconnect'
import { cancelSession, startSession, useNameProblem } from '../../../lib/remotes'
import { message } from '../../../lib/shell'
import BackendIcon, { BackendTile, backendLabel } from '../../components/BackendIcon'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import { Panel, SURFACE, SURFACE_HOVER } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { SHEET_COLUMN, SheetFooter, SheetHeader, sheetClass } from '../../components/SettingsWindow'
import { useUnsavedChanges } from '../../components/unsaved'
import { WINDOWS } from '../../routes'
import RemoteFields, { shownValues, useRemoteForm, valuesAsText } from './RemoteFields'

const LOOK = WINDOWS.remotes

/** The backends that are offered as cards, before the user picks a type. */
export const POPULAR = ['drive', 'dropbox', 'onedrive', 's3', 'b2', 'iclouddrive', 'sftp', 'webdav']

/** The sheet that creates a remote. `type` opens it with that type already picked. */
export default function RemoteCreateDrawer({
    isOpen,
    type,
    onClose,
}: {
    isOpen: boolean
    type?: string
    onClose: () => void
}) {
    const form = useRemoteForm()
    const {
        pending: config,
        setPending: setConfig,
        backends,
        fields,
        fieldsReady,
        missingCredentials,
    } = form

    // rclone's config/create overwrites a section with the same name before it runs any login,
    // so a name clash is caught while typing. The core checks again on create.
    const nameError = useNameProblem(config.name ?? '', !!config.name)

    // What the core refused when the create started, shown on the name and type fields. Typing
    // in a field clears its error.
    const [refused, setRefused] = useState<{ name?: string; type?: string }>({})

    // "More Options" stays open across a change of type and Reset.
    const [showMore, setShowMore] = useState(false)

    // Choosing another type clears the options below, so the type field says so once one is
    // filled in.
    const optionsFilled = Object.entries(config).some(
        ([k, v]) => k !== 'name' && k !== 'type' && v !== undefined && v !== null && v !== ''
    )

    // The config session that this drawer started. Closing the drawer cancels it, so a login
    // approved later creates nothing.
    const session = useRef<string | null>(null)

    // Anything typed or picked counts as a change, until the remote is created.
    const edited = Object.values(config).some((v) => v !== undefined && v !== null && v !== '')
    const unsaved = useUnsavedChanges(isOpen && edited)

    // The remote is created in the core as a config session. The session's questions are asked
    // here, and its sign-in opens the browser.
    const createRemoteMutation = useMutation({
        mutationFn: async ({
            name,
            type,
            values,
        }: {
            name: string
            type: string
            values: Record<string, string>
        }) => {
            const first = await startSession({ kind: 'create', name, type, values })
            session.current = first.id
            const end = await followSession(first, name)
            if (end?.state === 'failed') {
                throw new Error(sessionFailure(end, t`Unknown error occurred`))
            }
            return end?.state === 'done'
        },
        onSuccess: (created) => {
            if (!created) return
            unsaved.forget()
            close()
        },
        onError: async (error) => {
            console.error('Failed to create remote:', error)
            const fields = refusedFields(error)
            if (fields.name || fields.type) {
                setRefused({ name: fields.name, type: fields.type })
                return
            }
            await message(formatErrorMessage(error, t`Unknown error occurred`), {
                title: t`Could not create remote`,
                kind: 'error',
            })
        },
    })

    const reset = useCallback(() => {
        setConfig({})
        setRefused({})
        createRemoteMutation.reset()
    }, [setConfig, createRemoteMutation])

    const close = () => {
        // There is no need to check the session's state first. The core doesn't cancel a session
        // that is already completing, and it forgets sessions that have ended.
        if (session.current) cancelSession(session.current)
        session.current = null
        startTransition(reset)
        onClose()
    }

    // Every way of closing the drawer comes here (Cancel, Escape), and asks first when something
    // was entered.
    const requestClose = async () => {
        if (await unsaved.confirm()) close()
    }

    const handleTypeChange = useCallback(
        (key: Key | null) => {
            const newType = key ? String(key) : undefined
            setConfig((prev) => ({ name: prev.name, type: newType }))
            setRefused((prev) => ({ ...prev, type: undefined }))
        },
        [setConfig]
    )

    // A type picked before the sheet opened (in the empty Remotes window) starts the form.
    useEffect(() => {
        if (isOpen && type) handleTypeChange(type)
    }, [isOpen, type, handleTypeChange])

    const chosen = config.type
    const backend = chosen ? backendLabel(chosen) : ''
    const popular = POPULAR.filter((type) => backends.some((b) => b.name === type))

    return (
        <Drawer
            isOpen={isOpen}
            placement={'bottom'}
            size="full"
            onClose={requestClose}
            hideCloseButton={true}
        >
            <DrawerContent className={sheetClass()}>
                {(closeDrawer) => (
                    <>
                        <SheetHeader
                            tile={
                                chosen ? (
                                    <BackendTile type={chosen} size="xl" />
                                ) : (
                                    <IconTile icon={CloudIcon} tone={LOOK.tone} size="xl" />
                                )
                            }
                            title={chosen ? t`New ${backend} remote` : t`New remote`}
                            description={
                                chosen
                                    ? t`Fill in what it asks for, then create it. You connect it once.`
                                    : t`Name it, pick what kind of storage it is, then fill in what that provider asks for.`
                            }
                            actions={
                                <Button
                                    size="sm"
                                    variant="light"
                                    startContent={<ArrowsRotateIcon className="size-3.5" />}
                                    onPress={() => {
                                        setConfig({})
                                        setRefused({})
                                    }}
                                    isDisabled={!edited}
                                    data-focus-visible="false"
                                >
                                    {t({
                                        message: 'Reset',
                                        comment: 'Button: clears everything typed in the form.',
                                    })}
                                </Button>
                            }
                        />
                        <DrawerBody id="create-form-body">
                            <div className={cn(SHEET_COLUMN, 'flex flex-col gap-6 py-2')}>
                                <Panel className="flex flex-col gap-4 p-5">
                                    <Input
                                        id="remote-name"
                                        name="name"
                                        label={t({
                                            message: 'Name',
                                            comment: "Label of a remote's name.",
                                        })}
                                        labelPlacement="outside"
                                        placeholder={t`Remote name (for your reference)`}
                                        value={config.name || ''}
                                        onValueChange={(value) => {
                                            setConfig({ ...config, name: value })
                                            setRefused((prev) => ({ ...prev, name: undefined }))
                                        }}
                                        isRequired={true}
                                        isInvalid={!!(nameError || refused.name)}
                                        errorMessage={nameError || refused.name}
                                        autoComplete="off"
                                        autoCapitalize="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />

                                    <Autocomplete
                                        id="remote-type"
                                        name="type"
                                        label={t({
                                            message: 'Type',
                                            comment:
                                                'Label of the kind of storage a remote is (Google Drive, S3…).',
                                        })}
                                        labelPlacement="outside"
                                        placeholder={t`Select type or search`}
                                        selectedKey={config.type ?? null}
                                        onSelectionChange={handleTypeChange}
                                        isRequired={true}
                                        isInvalid={!!refused.type}
                                        errorMessage={refused.type}
                                        description={
                                            optionsFilled
                                                ? t`Choosing another type clears the options filled in below.`
                                                : undefined
                                        }
                                        startContent={
                                            chosen ? (
                                                <BackendIcon
                                                    type={chosen}
                                                    className="size-5 shrink-0"
                                                />
                                            ) : undefined
                                        }
                                        itemHeight={42}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    >
                                        {backends.map((backend) => (
                                            <AutocompleteItem
                                                key={backend.name}
                                                startContent={
                                                    <BackendIcon
                                                        type={backend.name}
                                                        alt={backend.name}
                                                        className="size-8"
                                                    />
                                                }
                                            >
                                                {backend.description || backend.name}
                                            </AutocompleteItem>
                                        ))}
                                    </Autocomplete>
                                </Panel>

                                {!chosen && popular.length > 0 && (
                                    <section
                                        aria-labelledby="popular-types"
                                        className="flex flex-col gap-3"
                                    >
                                        <SectionTitle
                                            id="popular-types"
                                            title={t`Popular kinds`}
                                            description={t`Pick one, or search every kind above.`}
                                        />
                                        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                                            {popular.map((type) => (
                                                <li key={type}>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleTypeChange(type)}
                                                        className={cn(
                                                            'flex flex-col items-center w-full gap-2.5 px-3 py-4 outline-none',
                                                            SURFACE,
                                                            SURFACE_HOVER,
                                                            'transition-[translate,scale,box-shadow] duration-150 ease-out hover:-translate-y-0.5 active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none motion-reduce:hover:translate-y-0'
                                                        )}
                                                    >
                                                        <BackendTile type={type} size="xl" />
                                                        <span className="font-medium text-small">
                                                            {backendLabel(type)}
                                                        </span>
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {chosen &&
                                    (fields.normal.length > 0 || fields.advanced.length > 0) && (
                                        <section
                                            aria-labelledby="remote-options"
                                            className="flex flex-col gap-3"
                                        >
                                            <SectionTitle
                                                id="remote-options"
                                                title={t`${backend} options`}
                                                description={t`Most can stay as they are. Sign-ins open in your browser when you create the remote.`}
                                            />
                                            <Panel className="flex flex-col gap-4 p-5">
                                                <RemoteFields
                                                    key={config.type ?? ''}
                                                    fields={fields}
                                                    values={config}
                                                    setValues={setConfig}
                                                    showMore={showMore}
                                                    onToggleMore={() =>
                                                        setShowMore((prev) => !prev)
                                                    }
                                                />
                                            </Panel>
                                        </section>
                                    )}
                            </div>
                        </DrawerBody>
                        <SheetFooter>
                            <Button variant="flat" onPress={closeDrawer} data-focus-visible="false">
                                <Trans>Cancel</Trans>
                            </Button>
                            <Button
                                color="primary"
                                className={toneButton(LOOK.tone)}
                                isLoading={createRemoteMutation.isPending}
                                isDisabled={
                                    missingCredentials.length > 0 ||
                                    !config.name ||
                                    !!nameError ||
                                    !fieldsReady
                                }
                                data-focus-visible="false"
                                onPress={() => {
                                    const { name, type, ...values } = config
                                    setRefused({})
                                    createRemoteMutation.mutate({
                                        name,
                                        type: type ?? '',
                                        values: valuesAsText(shownValues(values, fields)),
                                    })
                                }}
                            >
                                {createRemoteMutation.isPending ? t`Creating…` : t`Create remote`}
                            </Button>
                        </SheetFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
