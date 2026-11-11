import { Button, cn, Drawer, DrawerBody, DrawerContent, Input } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { PlugSimple as PlugSimpleIcon } from '@zappicon/react'
import { type MutableRefObject, useEffect, useRef, useState } from 'react'
import { coreError, formatErrorMessage, refusedFields, reportError } from '../../../lib/errors'
import { followSession, sessionFailure } from '../../../lib/reconnect'
import {
    cancelSession,
    checkRemote,
    startSession,
    useNameProblem,
    useRemoteConfig,
    useRemoteHealth,
} from '../../../lib/remotes'
import { message } from '../../../lib/shell'
import Alert from '../../components/Alert'
import { BackendTile, backendLabel } from '../../components/BackendIcon'
import EmptyState from '../../components/EmptyState'
import { toneButton } from '../../components/look/buttons'
import { Panel } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { StatusDot } from '../../components/look/Status'
import { SHEET_COLUMN, SheetFooter, SheetHeader, sheetClass } from '../../components/SettingsWindow'
import { useUnsavedChanges } from '../../components/unsaved'
import { WINDOWS } from '../../routes'
import { healthStatus, reconnect } from './RemoteCard'
import RemoteFields, { useRemoteForm, valuesAsText } from './RemoteFields'

// Saved fields that the drawer keeps read-only. Changing the provider would make it a different
// remote.
const LOCKED_FIELDS = ['provider'] as const

export default function RemoteEditDrawer({
    remoteName,
    onClose,
    isOpen,
}: {
    remoteName: string
    onClose: () => void
    isOpen: boolean
}) {
    const { data: saved, isFetchedAfterMount, isError, error } = useRemoteConfig(remoteName)
    const missing = isError && coreError(error)?.code === 'not_found'

    // The remote is checked again as the drawer opens, so a failing one says why at the top.
    const { refetch: refetchHealth } = useRemoteHealth()
    useEffect(() => {
        if (!isOpen) return
        checkRemote(remoteName)
            .then(() => refetchHealth())
            .catch((e: unknown) => console.warn('[remotes] checking the remote', e))
    }, [isOpen, remoteName, refetchHealth])
    // The form is filled once, from data fetched after the drawer opened. Cached data may be older
    // than the last save. A failed refetch keeps the cached data and still counts as fetched, so
    // an error doesn't fill the form either. Once filled, the form stays as it is: later
    // refetches never fill it again or unmount it.
    const [seededFor, setSeededFor] = useState<string>()
    const seeded = seededFor === remoteName
    if (!seeded && saved && isFetchedAfterMount && !isError) setSeededFor(remoteName)

    // The config session that the form started. Every way of closing the drawer goes through the
    // Drawer's onClose, which cancels the session, so a login approved later saves nothing. There
    // is no need to check the session's state first. The core doesn't cancel a session that is
    // already completing, and it forgets sessions that have ended.
    const session = useRef<string | null>(null)
    const closed = () => {
        if (session.current) cancelSession(session.current)
        session.current = null
        onClose()
    }

    // The form reports whether it holds changes. Closing the drawer or the window asks first.
    const [edited, setEdited] = useState(false)
    const unsaved = useUnsavedChanges(isOpen && edited)
    const requestClose = async () => {
        if (await unsaved.confirm()) closed()
    }

    return (
        <Drawer
            isOpen={isOpen}
            placement={'bottom'}
            size="full"
            onClose={requestClose}
            hideCloseButton={true}
        >
            <DrawerContent className={sheetClass()}>
                {(close) =>
                    seeded && saved ? (
                        // Keyed by name, so another remote gets a fresh form.
                        <EditForm
                            key={remoteName}
                            remoteName={remoteName}
                            saved={saved}
                            session={session}
                            close={close}
                            onEdited={setEdited}
                            forget={unsaved.forget}
                        />
                    ) : missing ? (
                        <DrawerBody>
                            <EmptyState
                                icon={PlugSimpleIcon}
                                tone={WINDOWS.remotes.tone}
                                title={t`No such remote`}
                                description={t`Rclone has no remote called ${remoteName}. It may have been renamed or removed.`}
                                actions={
                                    <Button
                                        variant="flat"
                                        onPress={close}
                                        data-focus-visible="false"
                                    >
                                        <Trans>Close</Trans>
                                    </Button>
                                }
                            />
                        </DrawerBody>
                    ) : (
                        <>
                            <SheetHeader
                                tile={<BackendTile type={undefined} size="xl" />}
                                title={t`Edit ${remoteName}`}
                                description={
                                    isError
                                        ? t`Its settings couldn’t be read.`
                                        : t`Reading the settings…`
                                }
                            />
                            <DrawerBody>
                                <div className={cn(SHEET_COLUMN, 'flex flex-col gap-6 py-2')}>
                                    {isError ? (
                                        <Alert
                                            color="danger"
                                            variant="faded"
                                            title={t`The remote's settings couldn't be read`}
                                        >
                                            <p className="text-small [overflow-wrap:anywhere]">
                                                {formatErrorMessage(error)}
                                            </p>
                                        </Alert>
                                    ) : (
                                        <FormSkeleton />
                                    )}
                                </div>
                            </DrawerBody>
                            {isError && (
                                <SheetFooter>
                                    <Button
                                        variant="flat"
                                        onPress={close}
                                        data-focus-visible="false"
                                    >
                                        <Trans>Close</Trans>
                                    </Button>
                                </SheetFooter>
                            )}
                        </>
                    )
                }
            </DrawerContent>
        </Drawer>
    )
}

function EditForm({
    remoteName,
    saved,
    session,
    close,
    onEdited,
    forget,
}: {
    remoteName: string
    saved: Record<string, string>
    session: MutableRefObject<string | null>
    close: () => void
    onEdited: (edited: boolean) => void
    forget: () => void
}) {
    // The values that the form started from. A refetch after the form opened doesn't change
    // anything typed here.
    const [seed] = useState(saved)
    const [name, setName] = useState(remoteName)
    const renaming = name !== remoteName
    const nameProblem = useNameProblem(name, renaming)
    // Why the core refused the rename, at the start or at the end of the save. Typing a name
    // clears it.
    const [renameError, setRenameError] = useState<string>()
    const nameError = nameProblem || renameError

    const [showMore, setShowMore] = useState(false)
    const health = useRemoteHealth().data?.[remoteName]
    // The check as the drawer opens reports the remote as checking for a moment. The last error
    // stays shown meanwhile, so the alert doesn't flicker; any other answer clears it.
    const [fault, setFault] = useState<string>()
    const nextFault =
        health?.state === 'faulty' ? health.error : health?.state === 'checking' ? fault : undefined
    if (nextFault !== fault) setFault(nextFault)

    const form = useRemoteForm({ saved: seed })
    const { pending: config, setPending: setConfig, effective, fields, missingCredentials } = form

    // A value typed back to what is saved isn't a change.
    const edited =
        renaming || Object.entries(config).some(([k, v]) => String(v ?? '') !== (seed[k] ?? ''))
    useEffect(() => {
        onEdited(edited)
    }, [edited, onEdited])
    useEffect(() => () => onEdited(false), [onEdited])

    // The save runs in the core as a config session. It writes only the changed keys, then
    // renames the remote.
    const updateRemoteMutation = useMutation({
        mutationFn: async () => {
            const first = await startSession({
                kind: 'update',
                name: remoteName,
                newName: renaming ? name : '',
                values: valuesAsText(config),
            })
            session.current = first.id
            const end = await followSession(first, remoteName)
            if (end?.state === 'failed') {
                // A failed rename shows under the name.
                if (end.field === 'newName' && end.error) {
                    setRenameError(end.error)
                    return null
                }
                throw new Error(sessionFailure(end, t`Unknown error occurred`))
            }
            return end
        },
        onSuccess: async (end) => {
            if (end?.state !== 'done') return
            if (end.notRewritten.length > 0) {
                const newName = end.resultName
                const places = end.notRewritten.join('\n')
                await message(
                    t`The remote is now called ${newName}, but these still name ${remoteName}:\n\n${places}`,
                    {
                        title: t({ message: 'Renamed', comment: 'Title: a remote was renamed.' }),
                        kind: 'warning',
                    }
                )
            }
            forget()
            close()
        },
        onError: async (error) => {
            const refused = refusedFields(error).newName
            if (refused) {
                setRenameError(refused)
                return
            }
            await reportError(error, {
                title: t`Could not update remote`,
                fallback: t`Unknown error occurred`,
                log: ['Failed to update remote:'],
            })
        },
    })

    const type = seed.type
    const backend = backendLabel(type)
    const status = healthStatus(health)

    return (
        <>
            <SheetHeader
                tile={<BackendTile type={type} alt={backendLabel(type)} size="xl" />}
                title={t`Edit ${remoteName}`}
                description={
                    <span className="flex items-center gap-1.5">
                        {backend}
                        {status && (
                            <>
                                <span aria-hidden={true}>·</span>
                                <StatusDot kind={status.kind} />
                                {status.label}
                            </>
                        )}
                    </span>
                }
            />
            <DrawerBody>
                <div className={cn(SHEET_COLUMN, 'flex flex-col gap-6 py-2')}>
                    {fault !== undefined && (
                        <Alert
                            color="danger"
                            variant="faded"
                            title={t`This remote is not working`}
                            endContent={
                                health?.state === 'faulty' &&
                                health.canReconnect && (
                                    <Button
                                        size="sm"
                                        color="danger"
                                        variant="flat"
                                        className="self-center shrink-0"
                                        startContent={<PlugSimpleIcon className="size-4" />}
                                        onPress={() => reconnect(remoteName)}
                                    >
                                        {t({
                                            message: 'Reconnect',
                                            comment:
                                                'Button: signs a remote in again after its sign-in expired.',
                                        })}
                                    </Button>
                                )
                            }
                        >
                            <p className="text-small [overflow-wrap:anywhere]">{fault}</p>
                        </Alert>
                    )}
                    <Panel className="flex flex-col gap-4 p-5">
                        <Input
                            id="edit-remote-name"
                            name="name"
                            label={t({ message: 'Name', comment: "Label of a remote's name." })}
                            labelPlacement="outside"
                            placeholder={t`Remote name (for your reference)`}
                            value={name}
                            onValueChange={(value) => {
                                setName(value)
                                setRenameError(undefined)
                            }}
                            isInvalid={!!nameError}
                            errorMessage={nameError}
                            description={
                                renaming && !nameError
                                    ? t`Saving renames the remote. Favorites, templates and mount settings follow the new name. Anything mounted or served under the old name keeps running until stopped.`
                                    : undefined
                            }
                            autoComplete="off"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck="false"
                        />
                    </Panel>

                    {(fields.normal.length > 0 || fields.advanced.length > 0) && (
                        <section
                            aria-labelledby="edit-remote-options"
                            className="flex flex-col gap-3"
                        >
                            <SectionTitle
                                id="edit-remote-options"
                                title={backend ? t`${backend} options` : t`Remote options`}
                                description={t`Only what you change is saved.`}
                            />
                            <Panel className="flex flex-col gap-4 p-5">
                                <RemoteFields
                                    fields={fields}
                                    values={effective}
                                    saved={seed}
                                    setValues={setConfig}
                                    disabledFields={LOCKED_FIELDS}
                                    showMore={showMore}
                                    onToggleMore={() => setShowMore((prev) => !prev)}
                                />
                            </Panel>
                        </section>
                    )}
                </div>
            </DrawerBody>
            <SheetFooter>
                <Button variant="flat" onPress={close} data-focus-visible="false">
                    <Trans>Close</Trans>
                </Button>
                <Button
                    color="primary"
                    className={toneButton(WINDOWS.remotes.tone)}
                    isLoading={updateRemoteMutation.isPending}
                    isDisabled={
                        missingCredentials.length > 0 ||
                        !!nameProblem ||
                        (Object.keys(config).length === 0 && !renaming)
                    }
                    data-focus-visible="false"
                    onPress={() => updateRemoteMutation.mutate()}
                >
                    {updateRemoteMutation.isPending ? t`Saving…` : t`Save changes`}
                </Button>
            </SheetFooter>
        </>
    )
}

function FormSkeleton() {
    const bar = 'rounded-full bg-default-200/70 animate-pulse motion-reduce:animate-none'
    return (
        <div
            aria-busy={true}
            aria-label={t`Reading the remote's settings`}
            className="flex flex-col gap-6"
        >
            {[1, 3].map((count) => (
                <Panel key={count} className="flex flex-col gap-5 p-5">
                    {Array.from({ length: count }, (_, i) => (
                        <div key={i} className="flex flex-col gap-2.5">
                            <span className={cn(bar, 'w-24 h-3')} />
                            <span className="h-10 rounded-xl bg-default-100 animate-pulse motion-reduce:animate-none" />
                        </div>
                    ))}
                </Panel>
            ))}
        </div>
    )
}
