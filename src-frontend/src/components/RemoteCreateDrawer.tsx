import { Alert, Drawer, DrawerBody, DrawerFooter, DrawerHeader, cn } from '@heroui/react'
import { Autocomplete, AutocompleteItem, Button, DrawerContent, Input } from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { RefreshCcwIcon } from 'lucide-react'
import { type Key, startTransition, useCallback, useRef, useState } from 'react'
import { UserCancelledError } from '../../lib/errors'
import rclone from '../../lib/rclone/client'
import { createRemoteInteractive, safeDeleteRemote } from '../../lib/rclone/interactive'
import { attendLogin, loginParameters, presentSignIn, stopStrayOAuth } from '../../lib/rclone/oauth'
import { INTERACTIVE_CONFIG_TYPES } from '../../lib/rclone/overrides'
import { checkRemoteName } from '../../lib/rclone/rename'
import RemoteFields from './remote/RemoteFields'
import { useRemoteForm } from './remote/useRemoteForm'
import { message } from '../../lib/api/dialog'

// Backends the create drawer never offers.
const CREATE_EXCLUDES = ['uptobox', 'tardigrade'] as const

export default function RemoteCreateDrawer({
    isOpen,
    onClose,
}: { isOpen: boolean; onClose: () => void }) {
    const queryClient = useQueryClient()

    // The names already taken, so a clash is caught while typing (the Sidebar's query, shared).
    // rclone's config/create overwrites a section of that name before it runs any login, and the
    // old settings are gone at that point — so the collision has to be stopped before the call,
    // not cleaned up after it. Same check as the rename field, which also rules out names rclone
    // would not accept.
    const remotesQuery = useQuery({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => await rclone('/config/listremotes').then((r) => r?.remotes),
        staleTime: 1000 * 60,
    })
    const [showMoreOptions, setShowMoreOptions] = useState(false)
    // The OAuth login of the creation in flight: its sign-in link (a tab shows it, the daemon
    // opens no browser there) and the way to stop it when the drawer is closed.
    const [authUrl, setAuthUrl] = useState<string | null>(null)
    const loginAbort = useRef<AbortController | null>(null)

    const form = useRemoteForm({ exclude: CREATE_EXCLUDES })
    const {
        pending: config,
        setPending: setConfig,
        backends: sortedEnrichedBackends,
        fields,
        missingCredentials,
    } = form

    const nameError = checkRemoteName(config.name ?? '', remotesQuery.data ?? [])
    // An empty field is not yet a mistake; it still has nothing to create.
    const shownNameError = config.name ? nameError : undefined

    const createRemoteMutation = useMutation({
        mutationFn: async ({
            name,
            type,
            parameters,
        }: { name: string; type: string; parameters: Record<string, any> }) => {
            console.log('[RemoteCreateDrawer] newRemoteConfig', name, type, parameters)

            const controller = new AbortController()
            loginAbort.current = controller
            setAuthUrl(null)
            // The drawer keeps the link on screen while rclone waits; the dialog is what offers
            // to open or copy it, once, as soon as the daemon has one.
            const login = {
                signal: controller.signal,
                onAuthUrl: (url: string) => {
                    setAuthUrl(url)
                    // Cancelling here is the drawer's own Cancel: the abort fails the blocked
                    // call as a cancellation, which is what deletes the section rclone wrote.
                    void presentSignIn(url, { what: name, onCancel: () => controller.abort() })
                },
            }

            if (INTERACTIVE_CONFIG_TYPES.includes(type)) {
                return createRemoteInteractive({ name, type, parameters, ...login })
            }

            // A login somebody walked away from would hold rclone's auth port.
            await stopStrayOAuth()
            try {
                await attendLogin(
                    () =>
                        rclone('/config/create', {
                            params: {
                                query: {
                                    name,
                                    type,
                                    parameters: JSON.stringify({
                                        ...parameters,
                                        ...loginParameters(),
                                    }),
                                    opt: JSON.stringify({ obscure: true }),
                                },
                            },
                        }),
                    login
                )
            } catch (error) {
                // rclone writes the remote before the login it runs, so a login that never
                // finished leaves a section with no token behind it — one the Remotes page would
                // offer to reconnect. Cancelled or failed, it goes; the interactive path
                // (createRemoteInteractive) has always cleaned up the same way.
                await safeDeleteRemote(name)
                throw error
            }

            return name
        },
        onSettled: () => {
            loginAbort.current = null
            setAuthUrl(null)
        },
        onSuccess: async (name) => {
            queryClient.setQueryData(['remotes', 'list', 'all'], (old: string[] | undefined) => [
                ...(old ?? []),
                name,
            ])
            onClose()
            setConfig({})
            setShowMoreOptions(false)
        },
        onError: async (error) => {
            console.error('Failed to create remote:', error)

            if (error instanceof UserCancelledError) {
                return
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

            if (errorMessage.includes('address already in use')) {
                await message(
                    'Rclone Oauth Client is stuck, please restart the UI to add new remotes',
                    {
                        title: 'Busy',
                        kind: 'error',
                    }
                )
                return
            }

            await message(errorMessage, {
                title: 'Could not create remote',
                kind: 'error',
            })
        },
    })

    const handleTypeChange = useCallback(
        (key: Key | null) => {
            const newType = key ? String(key) : undefined

            // preserve name when resetting type
            setConfig((prev) => ({ name: prev.name, type: newType }))
        },
        [setConfig]
    )

    return (
        <Drawer
            isOpen={isOpen}
            placement={'bottom'}
            size="full"
            onClose={() => {
                // Closing mid-login stops it on the daemon; the creation then ends as cancelled.
                loginAbort.current?.abort()
                startTransition(() => {
                    setConfig({})
                    setShowMoreOptions(false)
                    createRemoteMutation.reset()
                })
                onClose()
            }}
            hideCloseButton={true}
        >
            <DrawerContent
                className={cn(
                    'bg-content1/80 backdrop-blur-md dark:bg-content1/90',
                )}
            >
                {(close) => (
                    <>
                        <DrawerHeader className="flex flex-row justify-between gap-1">
                            <span>Create Remote</span>
                            <Button
                                size="sm"
                                variant="faded"
                                color="danger"
                                startContent={<RefreshCcwIcon className="w-3 h-3" />}
                                onPress={() => setConfig({})}
                                data-focus-visible="false"
                                className="gap-2"
                            >
                                Reset
                            </Button>
                        </DrawerHeader>
                        <DrawerBody id="create-form-body">
                            <div className="flex flex-col gap-4">
                                {authUrl && (
                                    <Alert
                                        color="primary"
                                        variant="faded"
                                        title="Finish signing in to rclone in your browser"
                                    >
                                        <p className="text-small">
                                            rclone is waiting for you to log in.{' '}
                                            <a
                                                href={authUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="font-medium underline"
                                            >
                                                Open sign-in page
                                            </a>
                                            , then come back here.
                                        </p>
                                    </Alert>
                                )}
                                <Input
                                    id="remote-name"
                                    name="name"
                                    label="name"
                                    labelPlacement="outside"
                                    placeholder="Remote name (for your reference)"
                                    value={config.name || ''}
                                    onValueChange={(value) => setConfig({ ...config, name: value })}
                                    isRequired={true}
                                    isInvalid={!!shownNameError}
                                    errorMessage={shownNameError}
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                />

                                <Autocomplete
                                    id="remote-type"
                                    name="type"
                                    label="type"
                                    labelPlacement="outside"
                                    placeholder="Select type or search"
                                    selectedKey={config.type ?? null}
                                    onSelectionChange={handleTypeChange}
                                    isRequired={true}
                                    itemHeight={42}
                                    autoCapitalize="off"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                >
                                    {sortedEnrichedBackends.map((backend) => (
                                        <AutocompleteItem
                                            key={backend.Name}
                                            startContent={
                                                <img
                                                    src={`/icons/backends/${backend.Name}.png`}
                                                    className="object-contain w-8 h-8"
                                                    alt={backend.Name}
                                                />
                                            }
                                        >
                                            {backend.Description || backend.Name}
                                        </AutocompleteItem>
                                    ))}
                                </Autocomplete>

                                <RemoteFields
                                    fields={fields}
                                    values={config}
                                    setValues={setConfig}
                                    showMore={showMoreOptions}
                                    onToggleMore={() => setShowMoreOptions((prev) => !prev)}
                                />
                            </div>
                        </DrawerBody>
                        <DrawerFooter>
                            <Button
                                color="danger"
                                variant="light"
                                onPress={close}
                                data-focus-visible="false"
                            >
                                {authUrl ? 'Cancel sign-in' : 'Cancel'}
                            </Button>
                            <Button
                                color="primary"
                                isLoading={createRemoteMutation.isPending}
                                isDisabled={missingCredentials.length > 0 || !!nameError}
                                data-focus-visible="false"
                                onPress={() => {
                                    setTimeout(() => {
                                        const { name, type, ...parameters } = config
                                        createRemoteMutation.mutate({
                                            name,
                                            type,
                                            parameters,
                                        })
                                    }, 10)
                                }}
                            >
                                {createRemoteMutation.isPending ? 'Creating...' : 'Create Remote'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
