import {
    Button,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
    cn,
} from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import { useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import { getHostInfo } from '../../lib/hosts'
import { usePersistedStore } from '../../store/persisted'
import { message } from '../../lib/api/dialog'
import { isNativeMac } from '../../lib/api/os'

interface HostFormState {
    name: string
    url: string
    authUser: string
    authPassword: string
}

const INITIAL_FORM_STATE: HostFormState = {
    name: '',
    url: '',
    authUser: '',
    authPassword: '',
}

export default function HostAddDrawer({
    isOpen,
    onClose,
}: {
    isOpen: boolean
    onClose: () => void
}) {
    const [form, setForm] = useState<HostFormState>(INITIAL_FORM_STATE)

    const hosts = usePersistedStore((state) => state.hosts)

    const addHostMutation = useMutation({
        mutationFn: async () => {
            const trimmedName = form.name.trim()
            let trimmedUrl = form.url.trim().toLowerCase()

            while (trimmedUrl.endsWith('/')) {
                trimmedUrl = trimmedUrl.slice(0, -1)
            }

            const connectionResult = await getHostInfo({
                url: trimmedUrl,
                authUser: form.authUser.trim() || undefined,
                authPassword: form.authPassword || undefined,
            })

            console.log('[addHost] connectionResult', connectionResult)

            if (!connectionResult) {
                throw new Error(
                    'Could not validate the host connection. Check the URL and try again.'
                )
            }

            const newHost = {
                id: crypto.randomUUID(),
                name: trimmedName,
                url: trimmedUrl,
                authUser: form.authUser.trim() || undefined,
                authPassword: form.authPassword || undefined,
                cliVersion: connectionResult.cliVersion,
                os: connectionResult.os,
            }

            usePersistedStore.setState((state) => ({
                hosts: [...state.hosts, newHost],
            }))

            return true
        },
        onSuccess: () => {
            setForm(INITIAL_FORM_STATE)
            onClose()
        },
        onError: onErrorDialog('Connection failed', undefined, {
            capture: false,
            log: ['[addHost] failed'],
        }),
    })

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
                    isNativeMac && 'pt-5'
                )}
            >
                {(close) => (
                    <>
                        <DrawerHeader>
                            <span>Add Host</span>
                        </DrawerHeader>
                        <DrawerBody>
                            <div className="flex flex-col gap-8">
                                <section className="flex flex-col gap-4">
                                    <Input
                                        label="Name"
                                        labelPlacement="outside"
                                        placeholder="Internal name (for your reference)"
                                        value={form.name}
                                        onValueChange={(value) =>
                                            setForm((prev) => ({ ...prev, name: value }))
                                        }
                                        isRequired={true}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />
                                    <Input
                                        label="URL"
                                        labelPlacement="outside"
                                        placeholder="http://15.123.67.512:8080"
                                        value={form.url}
                                        onValueChange={(value) =>
                                            setForm((prev) => ({ ...prev, url: value }))
                                        }
                                        isRequired={true}
                                        autoCapitalize="off"
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                        type="url"
                                    />
                                </section>

                                <section className="flex flex-col gap-4">
                                    <p className="text-sm font-semibold uppercase text-default-500">
                                        Auth
                                    </p>
                                    <Input
                                        label="User"
                                        labelPlacement="outside"
                                        placeholder="Optional username"
                                        value={form.authUser}
                                        onValueChange={(value) =>
                                            setForm((prev) => ({ ...prev, authUser: value }))
                                        }
                                        autoComplete="off"
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />
                                    <Input
                                        label="Password"
                                        labelPlacement="outside"
                                        placeholder="Optional password"
                                        value={form.authPassword}
                                        onValueChange={(value) =>
                                            setForm((prev) => ({ ...prev, authPassword: value }))
                                        }
                                        type="password"
                                        autoComplete="off"
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />
                                </section>
                            </div>
                        </DrawerBody>
                        <DrawerFooter>
                            <Button
                                color="danger"
                                variant="light"
                                onPress={() => {
                                    setForm(INITIAL_FORM_STATE)
                                    close()
                                }}
                                data-focus-visible="false"
                            >
                                Cancel
                            </Button>
                            <Button
                                color="primary"
                                isLoading={addHostMutation.isPending}
                                onPress={async () => {
                                    const trimmedName = form.name.trim()
                                    const trimmedUrl = form.url.trim().toLowerCase()

                                    if (!trimmedName || !trimmedUrl) {
                                        await message('Name and URL are required to add a host.', {
                                            title: 'Missing information',
                                            kind: 'warning',
                                        })
                                        return
                                    }

                                    const duplicateName = hosts.some(
                                        (host) =>
                                            host.name.trim().toLowerCase() ===
                                            trimmedName.toLowerCase()
                                    )

                                    if (duplicateName) {
                                        await message(
                                            'A host with this name already exists. Please choose a different name.',
                                            {
                                                title: 'Duplicate host',
                                                kind: 'warning',
                                            }
                                        )
                                        return
                                    }

                                    addHostMutation.mutate()
                                }}
                                data-focus-visible="false"
                            >
                                {addHostMutation.isPending ? 'Checking...' : 'Add Host'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
