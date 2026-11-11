import { Button, Chip, Input } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Plus as PlusIcon, Xmark as XmarkIcon } from '@zappicon/react'
import { startTransition, useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatErrorMessage } from '../../../lib/errors'
import { testProxy, updateSettings, useSettings } from '../../../lib/settings'
import { ask, message, relaunch } from '../../../lib/shell'
import { SettingRow } from './SettingsGroup'

/**
 * The proxy that rclone and the app's own requests go through, and the hosts that skip it. A
 * change restarts the app, because rclone reads the proxy only when it starts.
 */
export default function ProxyRows() {
    const urlId = useId()
    const hostsId = useId()
    const { settings } = useSettings()
    const proxy = settings?.proxy

    const [proxyUrl, setProxyUrl] = useState('')
    const [newHost, setNewHost] = useState('')
    const [isTestingProxy, setIsTestingProxy] = useState(false)
    // Only one save runs at a time. The controls are disabled until it finishes.
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        startTransition(() => {
            setProxyUrl(proxy?.url || '')
        })
    }, [proxy?.url])

    const ignoredHosts = useMemo(() => proxy?.ignoredHosts || [], [proxy?.ignoredHosts])

    // The proxy as last saved. It comes from the settings, or from the result of a save until
    // the settings catch up. Each change starts from this value, so removing a host right after
    // another one doesn't bring the first one back.
    const saved = useRef({ url: proxy?.url || '', ignoredHosts })
    useEffect(() => {
        saved.current = { url: proxy?.url || '', ignoredHosts }
    }, [proxy?.url, ignoredHosts])

    // Saves the proxy, then restarts the app when the change needs it. What was running starts
    // again. If something is running, the user is asked first, and the setting is saved before
    // that question either way. Returns true when the new proxy is in effect.
    const saveProxy = async (url: string, hosts: string[]): Promise<boolean> => {
        const res = await updateSettings({ proxy: { url, ignoredHosts: hosts } })
        saved.current = {
            url: res.settings?.proxy?.url ?? url,
            ignoredHosts: res.settings?.proxy?.ignoredHosts ?? hosts,
        }
        if (!res.restartRequired) {
            return true
        }
        return relaunch('/settings?section=network')
    }

    // Saves the proxy and tells the user the result: an error, a proxy that isn't in effect yet,
    // or "saved and applied" when sayApplied is set. Returns false on an error.
    const save = async (url: string, hosts: string[], sayApplied: boolean): Promise<boolean> => {
        let applied: boolean
        setIsSaving(true)
        try {
            applied = await saveProxy(url, hosts)
        } catch (error) {
            await message(formatErrorMessage(error), { title: t`Proxy not saved`, kind: 'error' })
            return false
        } finally {
            setIsSaving(false)
        }
        if (applied && !sayApplied) {
            return true
        }
        const notice = applied
            ? t`Rclone UI now connects through the proxy.`
            : t`The proxy is saved. It applies the next time Rclone UI starts.`
        await message(notice, { title: t`Proxy saved`, kind: 'info' })
        return true
    }

    const handleAddHost = async (host: string) => {
        const addingHost = host.trim()
        const { url, ignoredHosts: hosts } = saved.current

        if (addingHost && !hosts.includes(addingHost)) {
            if (await save(url, [...hosts, addingHost], false)) {
                setNewHost('')
            }
        }
    }

    const handleRemoveHost = async (host: string) => {
        const removingHost = host.trim()
        const { url, ignoredHosts: hosts } = saved.current

        if (removingHost) {
            await save(
                url,
                hosts.filter((h) => h !== removingHost),
                false
            )
        }
    }

    const handleUpdateProxyUrl = async (url: string) => {
        if (!url.trim()) {
            const example = 'http://proxy.example.com:8080'
            await message(t`Enter the URL of a proxy server, such as ${example}.`, {
                title: t`Proxy`,
                kind: 'error',
            })
            return
        }

        setIsTestingProxy(true)

        try {
            try {
                await testProxy(url)
            } catch (error) {
                const question = t`Rclone UI couldn't connect through this proxy. Save it anyway?`
                const saveAnyway = await ask(`${question}\n\n${formatErrorMessage(error)}`, {
                    title: t`Proxy test failed`,
                    kind: 'warning',
                    okLabel: t`Save anyway`,
                    cancelLabel: t`Cancel`,
                })
                if (!saveAnyway) {
                    return
                }
            }
            await save(url, saved.current.ignoredHosts, true)
        } finally {
            setIsTestingProxy(false)
        }
    }

    const hostsDisabled = !proxyUrl

    return (
        <>
            <SettingRow
                stacked={true}
                title={t`Proxy server`}
                titleId={urlId}
                description={t`Rclone UI and rclone connect through this server. It's tested before it's saved, and Rclone UI restarts to apply it.`}
            >
                <div className="flex flex-row flex-wrap items-start gap-2">
                    <Input
                        aria-labelledby={urlId}
                        placeholder={t({
                            message: 'http://user:password@host:port',
                            comment:
                                'The form of a proxy URL. The words user, password, host and port may be translated. Keep http://, the colons and the @.',
                        })}
                        value={proxyUrl}
                        onChange={(e) => setProxyUrl(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && proxyUrl && !isTestingProxy && !isSaving) {
                                handleUpdateProxyUrl(proxyUrl)
                            }
                        }}
                        className="flex-1 min-w-60"
                        classNames={{ input: 'font-mono text-small' }}
                        data-focus-visible="false"
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                    />

                    <div className="flex flex-row gap-2">
                        <Button
                            color="primary"
                            // As wide as the bandwidth's "Save", so the two fields end together.
                            className="min-w-32"
                            onPress={() => handleUpdateProxyUrl(proxyUrl)}
                            data-focus-visible="false"
                            isDisabled={!proxyUrl || isTestingProxy || isSaving}
                            isLoading={isTestingProxy}
                        >
                            {isTestingProxy ? t`Testing…` : t`Test and save`}
                        </Button>

                        {proxy?.url && (
                            <Button
                                color="danger"
                                variant="flat"
                                onPress={async () => {
                                    setProxyUrl('')
                                    await save('', [], false)
                                }}
                                data-focus-visible="false"
                                isDisabled={isTestingProxy || isSaving}
                            >
                                <Trans>Remove proxy</Trans>
                            </Button>
                        )}
                    </div>
                </div>
            </SettingRow>

            {/* The hosts matter only with a proxy, so they show once one is entered. */}
            {(proxyUrl || ignoredHosts.length > 0) && (
                <SettingRow
                    stacked={true}
                    title={t`Hosts that skip the proxy`}
                    titleId={hostsId}
                    description={
                        hostsDisabled
                            ? t`Enter a proxy server first. Then add the hosts to reach directly.`
                            : t`Rclone UI and rclone reach these hosts directly. A change restarts Rclone UI.`
                    }
                >
                    <div className="flex flex-col gap-3">
                        <Input
                            aria-labelledby={hostsId}
                            placeholder="example.com"
                            value={newHost}
                            onChange={(e) => setNewHost(e.target.value)}
                            data-focus-visible="false"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isSaving) {
                                    handleAddHost(newHost)
                                }
                            }}
                            endContent={
                                <Button
                                    size="sm"
                                    onPress={() => handleAddHost(newHost)}
                                    data-focus-visible="false"
                                    isIconOnly={true}
                                    variant="light"
                                    aria-label={t`Add host`}
                                    className="-me-2"
                                    isDisabled={hostsDisabled || isSaving}
                                >
                                    <PlusIcon className="size-4" />
                                </Button>
                            }
                            classNames={{ input: 'font-mono text-small' }}
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck="false"
                            isDisabled={hostsDisabled}
                        />

                        {ignoredHosts.length > 0 ? (
                            <ul className="flex flex-row flex-wrap gap-2 overflow-y-auto max-h-60">
                                {ignoredHosts.map((host) => (
                                    <li key={host}>
                                        <Chip
                                            variant="flat"
                                            endContent={
                                                <button
                                                    type="button"
                                                    aria-label={t`Remove ${host}`}
                                                    disabled={isSaving}
                                                    onClick={() => handleRemoveHost(host)}
                                                    className="grid rounded-full place-items-center size-5 text-default-500 transition-colors hover:bg-danger/15 hover:text-danger disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-focus"
                                                >
                                                    <XmarkIcon className="size-3.5" />
                                                </button>
                                            }
                                            classNames={{
                                                base: 'h-8 ps-1 pe-1.5 gap-0.5',
                                                content: 'font-mono text-small',
                                            }}
                                        >
                                            {host}
                                        </Chip>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-xs text-default-400">
                                <Trans>No hosts skip the proxy yet.</Trans>
                            </p>
                        )}
                    </div>
                </SettingRow>
            )}
        </>
    )
}
