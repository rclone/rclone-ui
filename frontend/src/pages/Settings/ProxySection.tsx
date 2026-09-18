import { Button, Divider, Input } from '@heroui/react'

import { PlusIcon, Trash2Icon } from 'lucide-react'
import { startTransition, useEffect, useMemo, useState } from 'react'
import { useHostStore } from '../../../store/host'
import BaseSection from './BaseSection'
import SettingsGroup, { type SettingsLayout } from './SettingsGroup'
import { ask, message } from '../../../lib/api/dialog'
import { rpc } from '../../../lib/api/rpc'

const URL_HINT = 'Set the proxy server URL for network requests'
const IGNORED_HINT = 'Hosts that should bypass the proxy server'

// Its own tab on the desktop; one half of the browser's Rclone screen, which is why the groups
// take their layout from the caller.
export default function ProxySection() {
    return (
        <BaseSection header={{ title: 'Proxy' }}>
            <ProxySettings layout="native" />
        </BaseSection>
    )
}

export function ProxySettings({ layout }: { layout: SettingsLayout }) {
    const proxy = useHostStore((state) => state.proxy)

    const [proxyUrl, setProxyUrl] = useState('')
    const [newHost, setNewHost] = useState('')
    const [isTestingProxy, setIsTestingProxy] = useState(false)

    useEffect(() => {
        startTransition(() => {
            setProxyUrl(proxy?.url || '')
        })
    }, [proxy?.url])

    const ignoredHosts = useMemo(() => proxy?.ignoredHosts || [], [proxy?.ignoredHosts])

    const handleAddHost = (host: string) => {
        const addingHost = host.trim()

        if (addingHost && !ignoredHosts.includes(addingHost)) {
            useHostStore.setState((state) => ({
                proxy: {
                    url: state.proxy?.url || '',
                    ignoredHosts: [...(state.proxy?.ignoredHosts || []), addingHost],
                },
            }))
            setNewHost('')
        }
    }

    const handleRemoveHost = (host: string) => {
        const removingHost = host.trim()

        if (removingHost) {
            useHostStore.setState((state) => ({
                proxy: {
                    url: state.proxy?.url || '',
                    ignoredHosts: ignoredHosts.filter((host) => host !== removingHost),
                },
            }))
        }
    }

    const handleUpdateProxyUrl = async (url: string) => {
        if (!url.trim()) {
            await message('Please enter a proxy URL', {
                title: 'Error',
                kind: 'error',
            })
            return
        }

        setIsTestingProxy(true)

        try {
            await rpc<string>('test_proxy_connection', { proxy_url: url })

            // If test successful, save the proxy URL
            useHostStore.setState((state) => ({
                proxy: {
                    url: url,
                    ignoredHosts: state.proxy?.ignoredHosts || [],
                },
            }))

            await message('The proxy has been saved!\n\nRestart the app to apply the changes.', {
                title: 'Proxy Saved',
                kind: 'info',
            })
        } catch (error) {
            const saveAnyway = await ask(
                `The proxy test failed. Do you want to save the URL anyway?\n\nError: ${error}`,
                {
                    title: 'Error',
                    kind: 'warning',
                    okLabel: 'Save Anyway',
                    cancelLabel: 'Cancel',
                }
            )

            if (saveAnyway) {
                useHostStore.setState((state) => ({
                    proxy: {
                        url: url,
                        ignoredHosts: state.proxy?.ignoredHosts || [],
                    },
                }))

                await message(
                    'The proxy has been saved!\n\nRestart the app to apply the changes.',
                    {
                        title: 'Proxy Saved',
                        kind: 'info',
                    }
                )
            }
        }
        setIsTestingProxy(false)
    }

    const urlControls = (
        <>
            <Input
                placeholder="http://user:pass@address:port"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                size="lg"
                data-focus-visible="false"
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
            />

            <div className="flex flex-row gap-2">
                <Button
                    size="sm"
                    onPress={() => handleUpdateProxyUrl(proxyUrl)}
                    data-focus-visible="false"
                    isDisabled={!proxyUrl || isTestingProxy}
                    isLoading={isTestingProxy}
                    fullWidth={true}
                >
                    {isTestingProxy ? 'Testing...' : 'Save Proxy URL'}
                </Button>

                {proxy?.url && (
                    <Button
                        size="sm"
                        color="danger"
                        variant="ghost"
                        onPress={() => {
                            useHostStore.setState(() => ({
                                proxy: undefined,
                            }))
                            setProxyUrl('')
                        }}
                        data-focus-visible="false"
                        isDisabled={isTestingProxy}
                    >
                        Clear
                    </Button>
                )}
            </div>
        </>
    )

    const ignoredHostControls = (
        <>
            <div className="flex flex-row gap-2">
                <Input
                    placeholder="example.com"
                    value={newHost}
                    onChange={(e) => setNewHost(e.target.value)}
                    size="lg"
                    data-focus-visible="false"
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            handleAddHost(newHost)
                        }
                    }}
                    endContent={
                        <Button
                            size="sm"
                            onPress={() => handleAddHost(newHost)}
                            data-focus-visible="false"
                            isIconOnly={true}
                            variant="faded"
                            isDisabled={!proxyUrl}
                        >
                            <PlusIcon className="w-5 h-5" />
                        </Button>
                    }
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                    isDisabled={!proxyUrl}
                />
            </div>

            <div className="flex flex-col gap-2 overflow-y-auto rounded-medium max-h-96">
                {ignoredHosts.map((host) => (
                    <div
                        key={host}
                        className="flex items-center justify-between p-2 pl-3.5 border rounded-medium border-divider bg-content2"
                    >
                        <span className="text-small">{host}</span>
                        <Button
                            size="sm"
                            color="danger"
                            variant="light"
                            isIconOnly={true}
                            onPress={() => handleRemoveHost(host)}
                            data-focus-visible="false"
                        >
                            <Trash2Icon className="w-4 h-4" />
                        </Button>
                    </div>
                ))}
                {ignoredHosts.length === 0 && (
                    <p className="py-4 text-center text-small text-neutral-500">
                        No ignored hosts configured
                    </p>
                )}
            </div>
        </>
    )

    // One card, not two: the URL and its exceptions are one setting, and a card apiece would say
    // otherwise. The desktop's labelled rows read fine as a pair, so they stay a pair.
    if (layout === 'web') {
        return (
            <SettingsGroup
                layout="web"
                title="Proxy"
                description={URL_HINT}
                contentClassName="gap-2"
            >
                {urlControls}
                <Divider className="my-2" />
                <div className="flex flex-col gap-1">
                    <h4 className="text-sm font-medium">Ignored hosts</h4>
                    <p className="text-xs text-default-500">{IGNORED_HINT}</p>
                </div>
                {ignoredHostControls}
            </SettingsGroup>
        )
    }

    return (
        <>
            <SettingsGroup
                layout="native"
                title="Proxy URL"
                description={URL_HINT}
                contentClassName="gap-2"
            >
                {urlControls}
            </SettingsGroup>

            <SettingsGroup layout="native" title="Ignored Hosts" description={IGNORED_HINT}>
                {ignoredHostControls}
            </SettingsGroup>
        </>
    )
}
