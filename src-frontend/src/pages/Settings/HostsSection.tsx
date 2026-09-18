import { Button, Card, CardBody, Checkbox, Chip, Tooltip } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import { PlusIcon, RefreshCcwIcon, Trash2Icon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { type Host, LABEL_FOR_OS, LOCAL_HOST_ID, getHostInfo } from '../../../lib/hosts'
import { useCurrentHost, usePersistedStore } from '../../../store/persisted'
import HostAddDrawer from '../../components/HostAddDrawer'
import BaseSection from './BaseSection'
import { ask, message } from '../../../lib/api/dialog'

export default function HostsSection() {
    const hosts = usePersistedStore((state) => state.hosts)
    const currentHost = useCurrentHost()

    const [isCreateDrawerOpen, setIsCreateDrawerOpen] = useState(false)

    const sortedHosts = useMemo(
        () =>
            [...hosts].sort((a, b) => {
                if (a.id === LOCAL_HOST_ID) return -1
                if (b.id === LOCAL_HOST_ID) return 1
                return a.name.localeCompare(b.name)
            }),
        [hosts]
    )

    return (
        <BaseSection
            header={{
                title: 'Hosts',
                endContent: (
                    <Button
                        onPress={() => setIsCreateDrawerOpen(true)}
                        isIconOnly={true}
                        variant="faded"
                        color="primary"
                        data-focus-visible="false"
                        size="sm"
                    >
                        <PlusIcon className="w-4 h-4" />
                    </Button>
                ),
            }}
        >
            <div className="flex flex-col gap-2.5 px-4 pb-10">
                {sortedHosts.map((host) => (
                    <HostCard key={host.id} host={host} isActive={currentHost?.id === host.id} />
                ))}
                {sortedHosts.length === 0 && (
                    <p className="py-10 text-sm text-center text-default-500">
                        No hosts configured yet.
                    </p>
                )}
            </div>
            <HostAddDrawer
                isOpen={isCreateDrawerOpen}
                onClose={() => setIsCreateDrawerOpen(false)}
            />
        </BaseSection>
    )
}

function HostCard({
    host,
    isActive,
}: {
    host: Host
    isActive: boolean
}) {
    const canDelete = useMemo(() => host.id !== LOCAL_HOST_ID && !isActive, [host.id, isActive])
    const isLocalHost = useMemo(() => host.id === LOCAL_HOST_ID, [host.id])

    const formattedSubtitle = useMemo(
        () => `${LABEL_FOR_OS[host.os]} • ${host.cliVersion}`,
        [host.os, host.cliVersion]
    )

    const changeHostMutation = useMutation({
        mutationFn: async (host: Host) => {
            if (isActive) {
                return
            }

            const confirmation = await ask(`Are you sure you want to change to ${host.name}?`, {
                title: 'Confirmation',
            })

            if (!confirmation) {
                return
            }

            usePersistedStore.getState().setCurrentHost(host.id)
        },
        onError: () => {
            message('Failed to change host. Please try again.', {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    const refreshHostMutation = useMutation({
        mutationFn: async (host: Host) => {
            const [hostInfo] = await Promise.all([
                getHostInfo({
                    hostId: host.id,
                    url: host.url,
                    authUser: host.authUser,
                    authPassword: host.authPassword,
                }),
                new Promise<void>((resolve) => setTimeout(resolve, 1500)),
            ])

            if (hostInfo?.cliVersion === host.cliVersion && hostInfo?.os === host.os) {
                return
            }

            usePersistedStore.setState((state) => ({
                hosts: state.hosts.map((h) => (h.id === host.id ? { ...h, ...hostInfo } : h)),
            }))
        },
        onError: () => {
            message('Failed to update host. Please try again.', {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    const removeHostMutation = useMutation({
        mutationFn: async (host: Host) => {
            if (host.id === LOCAL_HOST_ID || isActive) {
                return
            }

            usePersistedStore.setState((state) => ({
                hosts: state.hosts.filter((h) => h.id !== host.id),
            }))
        },
        onError: () => {
            message('Failed to remove host. Please try again.', {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    return (
        <Card
            shadow="sm"
            isPressable={!isActive}
            onPress={() => setTimeout(() => changeHostMutation.mutate(host), 100)}
            className={`group/card h-24 gap-2 bg-content2 ${isActive ? 'border-2 border-primary' : ''}`}
        >
            <CardBody>
                <div className="flex items-center justify-between w-full h-full px-2">
                    <div className="flex items-center gap-3">
                        <div className="relative size-12">
                            <img
                                src={`/icons/platforms/${host.os}.png`}
                                className="object-contain transition-opacity duration-150 ease-in-out bg-red-500/0 size-12 group-hover/card:opacity-0 group-focus-within/card:opacity-0"
                                alt={host.name}
                            />
                            <div className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 ease-in-out opacity-0 size-12 bg-red-500/0 group-hover/card:opacity-100 group-hover/card:pointer-events-auto group-focus-within/card:opacity-100 group-focus-within/card:pointer-events-auto">
                                <Checkbox
                                    isSelected={isActive}
                                    onValueChange={() =>
                                        setTimeout(() => changeHostMutation.mutate(host), 100)
                                    }
                                    size="lg"
                                    classNames={{
                                        base: 'size-10 flex items-center justify-center',
                                        icon: 'size-6',
                                        wrapper: 'size-9 m-0',
                                        label: 'm-0 p-0',
                                    }}
                                    data-focus-visible="false"
                                />
                            </div>
                        </div>
                        <div className="flex flex-col gap-1">
                            <p className="font-medium text-large">{host.name}</p>
                            <p className="text-small text-default-500">{formattedSubtitle}</p>
                        </div>
                    </div>
                    <div className="relative flex items-center justify-end">
                        <div className="absolute right-0 flex items-center justify-center gap-2 transition-opacity duration-150 ease-in-out opacity-0 pointer-events-none group-hover/card:opacity-100 group-hover/card:pointer-events-auto group-focus-within/card:opacity-100 group-focus-within/card:pointer-events-auto">
                            <Tooltip content="Refresh" color="primary" size="lg">
                                <Button
                                    isIconOnly={true}
                                    variant="light"
                                    data-focus-visible="false"
                                    onPress={() =>
                                        setTimeout(() => refreshHostMutation.mutate(host), 100)
                                    }
                                    isLoading={refreshHostMutation.isPending}
                                >
                                    <RefreshCcwIcon className="size-5" />
                                </Button>
                            </Tooltip>
                            <Tooltip
                                content={
                                    isLocalHost
                                        ? 'Local host cannot be removed'
                                        : canDelete
                                          ? 'Remove Host'
                                          : 'Cannot remove active host'
                                }
                                color="danger"
                                size="lg"
                            >
                                <div>
                                    <Button
                                        isIconOnly={true}
                                        variant="light"
                                        size="lg"
                                        isDisabled={!canDelete}
                                        onPress={() => {
                                            setTimeout(async () => {
                                                const confirmation = await ask(
                                                    `Are you sure you want to remove ${host.name}? This action cannot be reverted.`,
                                                    {
                                                        title: `Removing ${host.name}`,
                                                        kind: 'warning',
                                                    }
                                                )

                                                if (!confirmation) {
                                                    return
                                                }

                                                removeHostMutation.mutate(host)
                                            }, 100)
                                        }}
                                        data-focus-visible="false"
                                        className="transition-opacity duration-150 ease-in-out opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100"
                                        isLoading={removeHostMutation.isPending}
                                    >
                                        <Trash2Icon className="size-5" />
                                    </Button>
                                </div>
                            </Tooltip>
                        </div>

                        <div className="absolute right-0 flex items-center justify-center duration-150 ease-in-out opacity-100 group-hover/card:opacity-0 group-focus-within/card:opacity-0 group-hover/card:pointer-events-none group-focus-within/card:pointer-events-none">
                            <Chip
                                size="lg"
                                radius="sm"
                                variant="flat"
                                color="success"
                                className="uppercase"
                            >
                                Online
                            </Chip>
                        </div>
                    </div>
                </div>
            </CardBody>
        </Card>
    )
}
