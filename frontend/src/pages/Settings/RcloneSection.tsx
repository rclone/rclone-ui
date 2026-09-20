import { Button, Checkbox, Chip, Divider, Input, Progress, Spinner } from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { FolderOpenIcon, HardDriveIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react'
import { startTransition, useEffect, useMemo, useState } from 'react'

import { ask, message, pickPath } from '@/dialog'
import { formatErrorMessage, reportError } from '@/lib/errors'
import { RCLONE_RELEASES_SHOWN, RCLONE_RELEASES_STEP } from '@/lib/rclone/constants'
import { openUrl } from '@/navigate'
import {
    type RcloneBinary,
    type UpdateInfo,
    daemonSettingsSet,
    rcloneBinary,
    rcloneSetCustom,
    relaunch,
    status,
    testProxyConnection,
    updateCheck,
    updateInstall,
} from '@/server/app'
import { capabilities } from '@/server/boot'
import { usePersistedStore } from '@/store'
import BaseSection from './BaseSection'
import SettingsGroup from './SettingsGroup'
import {
    type DownloadProgress,
    confirmIfBusy,
    fetchAvailableVersions,
    installVersion,
    isRcloneBusy,
} from './rcloneVersions'

// The one screen for the rclone the server runs: which binary, the limits every transfer shares,
// the proxy it reaches the world through, and the server's own updates. There is no group for a
// config file — rclone resolves its own, and the file itself is edited from the remotes list.
export default function RcloneSection() {
    return (
        <BaseSection
            header={{ title: 'Rclone' }}
            className="w-full max-w-3xl gap-4 px-6 pb-12 mx-auto"
        >
            <BinarySettings />
            <LimitsSettings />
            <ProxySettings />
            <UpdateSettings />
        </BaseSection>
    )
}

/** Warning for binaries below the version floor the app's Serve feature needs. */
const KIND_LABEL = {
    pinned: 'Pinned by --rclone-path',
    custom: 'Custom binary',
    system: 'On PATH',
} as const

/**
 * Which rclone the server runs, a custom one in its place, its updates, and the installer. There
 * is one rclone: a version installed here replaces the server's own where it lives.
 */
function BinarySettings() {
    const queryClient = useQueryClient()
    const [progress, setProgress] = useState<DownloadProgress | null>(null)
    // How many releases the list is currently asking for; Load more asks for ten more.
    const [releaseLimit, setReleaseLimit] = useState(RCLONE_RELEASES_SHOWN)

    const binary = useQuery({ queryKey: ['rclone', 'binary'], queryFn: rcloneBinary }).data
    // Somebody else's daemon (`--rclone-url`): there is no binary here to show or replace.
    const external = binary?.kind === 'external'
    const releasesQuery = useQuery({
        queryKey: ['rclone', 'releases', releaseLimit],
        queryFn: () => fetchAvailableVersions(releaseLimit),
        staleTime: 60 * 60 * 1000,
        retry: 1,
        placeholderData: (previous) => previous,
        enabled: !!binary && !external,
    })
    const refresh = () => queryClient.invalidateQueries({ queryKey: ['rclone'] })

    const installMutation = useMutation({
        mutationFn: async (version: string) => {
            if (binary?.kind === 'custom') {
                const proceed = await ask(
                    `This installs rclone v${version} at ${binary.installTarget} and stops using the custom binary. The custom binary itself is not touched.`,
                    { title: 'Install rclone', okLabel: 'Install', cancelLabel: 'Cancel' }
                )
                if (!proceed) return
            }
            if (!(await confirmIfBusy())) return
            await installVersion(version, setProgress)
        },
        onSettled: () => {
            setProgress(null)
            refresh()
        },
        onError: async (e) => {
            await message(`Install failed: ${formatErrorMessage(e, String(e))}`, {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    if (!binary) return null
    if (binary.kind === 'external') {
        return (
            <SettingsGroup title="Binary">
                <span className="text-sm text-neutral-500">
                    This server does not run rclone itself (--rclone-url). Update that rclone on its
                    own machine.
                </span>
            </SettingsGroup>
        )
    }

    const releases = releasesQuery.data ?? []
    const mayHaveMore = releases.length >= releaseLimit
    const installed = binary.kind === 'custom' ? null : binary.version
    const latest = releases[0]?.version
    const percent = progress?.total
        ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
        : undefined

    return (
        <>
            <SettingsGroup title="Binary">
                <div className="flex items-center gap-3">
                    <HardDriveIcon className="w-5 h-5 shrink-0 text-neutral-400" />
                    <div className="flex flex-col flex-1 min-w-0">
                        <span className="text-sm">
                            {binary.version ? `rclone v${binary.version}` : 'No rclone found'}
                        </span>
                        <span className="text-xs truncate text-neutral-500">{binary.path}</span>
                    </div>
                    {binary.kind && (
                        <Chip size="sm" variant="flat">
                            {KIND_LABEL[binary.kind]}
                        </Chip>
                    )}
                </div>
            </SettingsGroup>

            <SettingsGroup title="Custom binary">
                <CustomBinaryRow binary={binary} onChanged={refresh} />
            </SettingsGroup>

            <SettingsGroup title="Updates">
                <AutoUpdateRow installTarget={binary.installTarget} />
            </SettingsGroup>

            <SettingsGroup title="Versions">
                {binary.installBlocked ? (
                    <span className="text-xs text-warning">
                        {binary.installBlocked} Run <code>rclone selfupdate</code> on the server
                        instead.
                    </span>
                ) : (
                    <span className="text-xs text-neutral-500">
                        Installing a version replaces {binary.installTarget}.
                    </span>
                )}
                <div className="flex flex-col overflow-hidden border divide-y rounded-medium border-divider divide-divider">
                    {releases.map((release) => {
                        const isInstalling =
                            installMutation.isPending &&
                            installMutation.variables === release.version
                        return (
                            <div
                                key={release.version}
                                className="flex items-center gap-3 px-4 py-3"
                            >
                                <div className="flex flex-col flex-1 min-w-0">
                                    <span className="text-sm">v{release.version}</span>
                                    {isInstalling && (
                                        <Progress
                                            aria-label="download progress"
                                            size="sm"
                                            value={percent ?? 0}
                                            isIndeterminate={percent === undefined}
                                            className="mt-1 max-w-52"
                                        />
                                    )}
                                </div>
                                {release.version === installed ? (
                                    <Chip size="sm" color="success" variant="flat">
                                        INSTALLED
                                    </Chip>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="flat"
                                        color={release.version === latest ? 'primary' : 'default'}
                                        isLoading={isInstalling}
                                        isDisabled={
                                            !!binary.installBlocked || installMutation.isPending
                                        }
                                        onPress={() => installMutation.mutate(release.version)}
                                        data-focus-visible="false"
                                    >
                                        {release.version === latest && installed
                                            ? 'Update'
                                            : 'Install'}
                                    </Button>
                                )}
                            </div>
                        )
                    })}

                    {releases.length === 0 && releasesQuery.isError && (
                        <div className="flex items-center justify-between gap-2 px-4 py-3">
                            <span className="text-xs text-warning">
                                Couldn't load available versions (offline or rate-limited).
                            </span>
                            <Button
                                size="sm"
                                variant="light"
                                onPress={() => releasesQuery.refetch()}
                                startContent={<RefreshCwIcon className="w-3.5 h-3.5" />}
                                data-focus-visible="false"
                            >
                                Retry
                            </Button>
                        </div>
                    )}

                    {releasesQuery.isLoading && (
                        <div className="flex items-center justify-center py-6">
                            <Spinner size="sm" />
                        </div>
                    )}
                </div>

                {mayHaveMore && (
                    <Button
                        size="sm"
                        variant="flat"
                        isLoading={releasesQuery.isFetching}
                        onPress={() => setReleaseLimit(releaseLimit + RCLONE_RELEASES_STEP)}
                        data-focus-visible="false"
                    >
                        Load more
                    </Button>
                )}
            </SettingsGroup>
        </>
    )
}

/** A binary that runs instead of the server's own. It is never updated or replaced. */
function CustomBinaryRow({
    binary,
    onChanged,
}: {
    binary: RcloneBinary
    onChanged: () => void
}) {
    const pinned = binary.kind === 'pinned'
    const [value, setValue] = useState(binary.custom ?? '')
    useEffect(() => setValue(binary.custom ?? ''), [binary.custom])

    // The server probes the binary, refuses one older than it can run, and restarts on it.
    const setMutation = useMutation({
        mutationFn: async (path: string | null) => {
            if (!(await confirmIfBusy())) return
            await rcloneSetCustom(path)
        },
        onSuccess: () => onChanged(),
        onError: async (e) => {
            await reportError(e, { title: 'Invalid binary', fallback: String(e) })
        },
    })

    const browse = async () => {
        const selected = await pickPath({
            multiple: false,
            directory: false,
            title: 'Select rclone binary',
        })
        if (typeof selected === 'string') {
            setValue(selected)
            // Picking a binary implies using it — no separate button.
            setMutation.mutate(selected)
        }
    }

    return (
        <div className="flex flex-col gap-2">
            <Input
                value={value}
                onValueChange={setValue}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && value) {
                        setMutation.mutate(value)
                    }
                }}
                size="lg"
                placeholder="Point to an rclone binary on your machine (/path/to/rclone)"
                autoComplete="off"
                isDisabled={pinned}
                endContent={
                    setMutation.isPending ? (
                        <Spinner size="sm" />
                    ) : (
                        <button
                            type="button"
                            onClick={browse}
                            disabled={pinned}
                            className="transition-colors text-neutral-400 hover:text-neutral-200"
                        >
                            <FolderOpenIcon className="w-5 h-5" />
                        </button>
                    )
                }
            />
            <span className="text-xs text-neutral-500">
                {pinned
                    ? 'The server was started with --rclone-path, which decides the binary.'
                    : 'Runs instead of the rclone on PATH. It is never updated or replaced.'}
            </span>
            {binary.custom && (
                <div className="flex items-center gap-3">
                    <span
                        className={
                            binary.kind === 'custom'
                                ? 'text-xs text-success'
                                : 'text-xs text-warning'
                        }
                    >
                        {binary.kind === 'custom'
                            ? 'Currently using this custom binary.'
                            : 'This custom binary does not run, so it is not the one in use.'}
                    </span>
                    <Button
                        size="sm"
                        variant="light"
                        isLoading={setMutation.isPending}
                        onPress={() => setMutation.mutate(null)}
                        data-focus-visible="false"
                    >
                        Stop using it
                    </Button>
                </div>
            )}
        </div>
    )
}

function AutoUpdateRow({ installTarget }: { installTarget?: string | null }) {
    const autoUpdate = usePersistedStore((state) => state.autoUpdateRclone)

    return (
        <div className="flex flex-col gap-2">
            <Checkbox
                isSelected={autoUpdate}
                onValueChange={(checked) =>
                    usePersistedStore.getState().setAutoUpdateRclone(checked)
                }
            >
                Automatically update rclone
            </Checkbox>
            <span className="text-xs text-neutral-500">
                At startup a newer stable release replaces{' '}
                {installTarget ?? "the server's own rclone"}. When off, or when the server cannot
                write there, you are notified instead. A custom or pinned binary is never touched.
            </span>
        </div>
    )
}

// One rclone process shares these across every transfer, so they are set here and not per
// transfer. Bandwidth can be changed on a running rclone; the two transaction limits are read
// once, when it starts.
function LimitsSettings() {
    const limits = usePersistedStore((state) => state.limits)
    const managed = useQuery({ queryKey: ['server', 'status'], queryFn: status }).data
        ?.managedDaemon
    const [bwLimit, setBwLimit] = useState('')
    const [tpsLimit, setTpsLimit] = useState('')
    const [tpsLimitBurst, setTpsLimitBurst] = useState('')
    const [isSaving, setIsSaving] = useState(false)

    const shown = useMemo(
        () => ({
            bwLimit: limits?.bwLimit ?? '',
            tpsLimit: limits?.tpsLimit ? String(limits.tpsLimit) : '',
            tpsLimitBurst: limits?.tpsLimitBurst ? String(limits.tpsLimitBurst) : '',
        }),
        [limits]
    )
    useEffect(() => {
        setBwLimit(shown.bwLimit)
        setTpsLimit(shown.tpsLimit)
        setTpsLimitBurst(shown.tpsLimitBurst)
    }, [shown])

    const tps = tpsLimit.trim() === '' ? 0 : Number(tpsLimit)
    const burst = tpsLimitBurst.trim() === '' ? 0 : Number(tpsLimitBurst)
    const tpsProblem =
        !Number.isFinite(tps) || tps < 0 ? 'A number of requests per second, or empty' : undefined
    const burstProblem =
        !Number.isInteger(burst) || burst < 0 ? 'A whole number, or empty' : undefined
    const bwChanged = bwLimit.trim() !== shown.bwLimit
    const tpsChanged =
        tpsLimit.trim() !== shown.tpsLimit || tpsLimitBurst.trim() !== shown.tpsLimitBurst

    const save = async () => {
        setIsSaving(true)
        try {
            if (tpsChanged && (await isRcloneBusy())) {
                const restart = await ask(
                    'Rclone is currently busy. Wait for the transfers to finish, or restart it now.\n\nRestarting interrupts every running transfer and scheduled run, and unmounts what is mounted.',
                    {
                        title: 'Rclone is busy',
                        kind: 'warning',
                        okLabel: 'Restart now',
                        cancelLabel: 'Cancel',
                    }
                )
                if (!restart) {
                    setTpsLimit(shown.tpsLimit)
                    setTpsLimitBurst(shown.tpsLimitBurst)
                    return
                }
            }
            const saved = usePersistedStore.getState().limits
            const next = {
                bwLimit: bwLimit.trim(),
                tpsLimit: tpsChanged ? tps : (saved?.tpsLimit ?? 0),
                tpsLimitBurst: tpsChanged ? (tps > 0 ? burst : 0) : (saved?.tpsLimitBurst ?? 0),
            }
            try {
                // The server puts the bandwidth on the running rclone first (what judges its
                // syntax), then restarts it if a transaction limit changed.
                await daemonSettingsSet({ limits: next })
            } catch (error) {
                await message(formatErrorMessage(error), {
                    title: bwChanged ? 'Bandwidth limit not accepted' : 'Limits not saved',
                    kind: 'error',
                })
            }
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <SettingsGroup
            title="Limits"
            description="Shared by every transfer, scheduled runs included."
            contentClassName="gap-4"
        >
            <Input
                label="Bandwidth"
                labelPlacement="outside"
                placeholder="No limit"
                description="Like 10M, or 10M:5M for upload and download. Applies at once."
                value={bwLimit}
                onValueChange={setBwLimit}
                size="lg"
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
            />
            <Input
                label="Transactions per second"
                labelPlacement="outside"
                placeholder="No limit"
                description={
                    managed === false
                        ? 'This server does not run rclone itself (--rclone-url): start that rclone with --tpslimit.'
                        : 'Requests per second, to stay under a provider’s quota. Changing it restarts rclone.'
                }
                value={tpsLimit}
                onValueChange={setTpsLimit}
                isInvalid={!!tpsProblem}
                errorMessage={tpsProblem}
                isDisabled={managed === false}
                inputMode="decimal"
                size="lg"
            />
            <Input
                label="Transaction burst"
                labelPlacement="outside"
                placeholder="1"
                description="How many requests may go at once before the limit above holds them back."
                value={tpsLimitBurst}
                onValueChange={setTpsLimitBurst}
                isInvalid={!!burstProblem}
                errorMessage={burstProblem}
                isDisabled={managed === false || tps <= 0 || !!tpsProblem}
                inputMode="numeric"
                size="lg"
            />
            <Button
                size="sm"
                onPress={save}
                isLoading={isSaving}
                isDisabled={
                    isSaving || !!tpsProblem || !!burstProblem || (!bwChanged && !tpsChanged)
                }
                data-focus-visible="false"
            >
                Save limits
            </Button>
        </SettingsGroup>
    )
}

const URL_HINT = 'Set the proxy server URL for network requests'
const IGNORED_HINT = 'Hosts that should bypass the proxy server'

// The proxy half of this screen.
function ProxySettings() {
    const proxy = usePersistedStore((state) => state.proxy)

    const [proxyUrl, setProxyUrl] = useState('')
    const [newHost, setNewHost] = useState('')
    const [isTestingProxy, setIsTestingProxy] = useState(false)

    useEffect(() => {
        startTransition(() => {
            setProxyUrl(proxy?.url || '')
        })
    }, [proxy?.url])

    const ignoredHosts = useMemo(() => proxy?.ignoredHosts || [], [proxy?.ignoredHosts])

    // Saved on the server, which the daemon reads at its next start; the store follows through
    // `state.changed`.
    const saveProxy = async (next: { url: string; ignoredHosts: string[] } | null) => {
        try {
            await daemonSettingsSet({ proxy: next })
        } catch (error) {
            await message(formatErrorMessage(error), { title: 'Proxy not saved', kind: 'error' })
        }
    }

    const handleAddHost = async (host: string) => {
        const addingHost = host.trim()
        if (addingHost && !ignoredHosts.includes(addingHost)) {
            await saveProxy({ url: proxy?.url || '', ignoredHosts: [...ignoredHosts, addingHost] })
            setNewHost('')
        }
    }

    const handleRemoveHost = async (host: string) => {
        const removingHost = host.trim()
        if (removingHost) {
            await saveProxy({
                url: proxy?.url || '',
                ignoredHosts: ignoredHosts.filter((h) => h !== removingHost),
            })
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
            await testProxyConnection(url)

            // If test successful, save the proxy URL
            await saveProxy({ url, ignoredHosts })

            await message('The proxy has been saved!\n\nRestart rclone to apply the changes.', {
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
                await saveProxy({ url, ignoredHosts })

                await message('The proxy has been saved!\n\nRestart rclone to apply the changes.', {
                    title: 'Proxy Saved',
                    kind: 'info',
                })
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
                            void saveProxy(null)
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

    // One card, not two: the URL and its exceptions are one setting.
    return (
        <SettingsGroup title="Proxy" description={URL_HINT} contentClassName="gap-2">
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

/** The server's own update, where the machine lets it install one (not in a container). */
function UpdateSettings() {
    const caps = capabilities
    const [buttonText, setButtonText] = useState('Check for updates')
    const [update, setUpdate] = useState<UpdateInfo | null>(null)

    const updateMutation = useMutation({
        mutationFn: async () => {
            if (!update) {
                setButtonText('Checking...')
                let found: UpdateInfo | null = null
                try {
                    found = await updateCheck()
                } catch (e) {
                    console.error('[update] check failed', e)
                    setButtonText('Failed to check')
                    return
                }
                if (!found) {
                    setButtonText('Up to date')
                    return
                }
                setUpdate(found)
                setButtonText(`Install v${found.version}`)
                return
            }

            setButtonText('Downloading...')
            try {
                await updateInstall()
            } catch (error) {
                console.error('[update] install failed', error)
                setButtonText('Tap to retry')
                const manual = await ask(
                    'The update could not be installed. Try again, or download it yourself.',
                    {
                        title: 'Update Error',
                        kind: 'error',
                        okLabel: 'Download',
                        cancelLabel: 'Cancel',
                    }
                )
                // The repository's Latest is the desktop app's; the cloud's releases are tagged.
                if (manual) {
                    await openUrl(
                        `https://github.com/rclone/rclone-ui/releases/tag/cloud-v${update.version}`
                    )
                }
                return
            }

            const restart = await ask('Update installed. Ready to restart?', {
                title: 'Update',
                kind: 'info',
                okLabel: 'Restart',
                cancelLabel: 'Later',
            })
            if (restart) await relaunch()
        },
    })

    if (!caps.updater) return null
    return (
        <SettingsGroup
            title="Server"
            description={update ? `Version ${update.version} is available.` : undefined}
        >
            <Button
                className="self-start"
                isLoading={updateMutation.isPending}
                onPress={() => updateMutation.mutate()}
            >
                {buttonText}
            </Button>
        </SettingsGroup>
    )
}
