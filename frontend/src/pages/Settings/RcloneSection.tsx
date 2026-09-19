import {
    Button,
    Checkbox,
    Chip,
    Divider,
    Input,
    Progress,
    Spinner,
    Tooltip,
} from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
    DownloadIcon,
    FolderOpenIcon,
    HardDriveIcon,
    PlusIcon,
    RefreshCwIcon,
    Trash2Icon,
} from 'lucide-react'
import { startTransition, useEffect, useMemo, useState } from 'react'

import { ask, message, pickPath } from '../../../lib/api/dialog'
import { formatErrorMessage, reportError } from '../../../lib/errors'
import { formatBytes } from '../../../lib/format'
import {
    classifyRclonePath,
    compareVersions,
    findSystemRclone,
    probeRcloneBinaryOrThrow,
    validateRcloneBinary,
} from '../../../lib/rclone/common'
import {
    MIN_RCLONE_VERSION,
    RCLONE_RELEASES_STEP,
    RCLONE_RELEASES_SHOWN,
} from '../../../lib/rclone/constants'
import {
    type DownloadProgress,
    type DownloadedVersion,
    activateRclonePath,
    deleteVersion,
    downloadVersion,
    fetchAvailableVersions,
    getPathIntegration,
    isRcloneBusy,
    listDownloadedVersions,
    setPathIntegration,
} from '../../../lib/rclone/versions'
import { status } from '../../../lib/api/app'
import { restartActiveRclone } from '../../../lib/rclone/cli'
import rclone from '../../../lib/rclone/client'
import { usePersistedStore } from '../../../store/persisted'
import SettingsGroup from './SettingsGroup'
import { useHostStore } from '../../../store/host'
import { rpc } from '../../../lib/api/rpc'
import BaseSection from './BaseSection'

// The one screen for the rclone the server runs: which binary, the limits every transfer shares,
// and the proxy it reaches the world through. There is no group for a config file — rclone
// resolves its own, and the file itself is edited from the remotes list.
export default function RcloneSection() {
    return (
        <BaseSection
            header={{ title: 'Rclone' }}
            className="w-full max-w-3xl gap-4 px-6 pb-12 mx-auto"
        >
            <BinarySettings />
            <LimitsSettings />
            <ProxySettings />
        </BaseSection>
    )
}

/** Warning for binaries below the version floor the app's Serve feature needs. */
function subFloorWarning(version: string | null | undefined): string | null {
    if (!version) return null
    return compareVersions(version, MIN_RCLONE_VERSION) < 0
        ? `Serve requires rclone ≥ ${MIN_RCLONE_VERSION.split('.').slice(0, 2).join('.')}`
        : null
}

// The binary settings, beside the proxy settings below.
function BinarySettings() {
    const queryClient = useQueryClient()
    const rclonePath = usePersistedStore((state) => state.rclonePath)
    const [progress, setProgress] = useState<Record<string, DownloadProgress>>({})
    // How many releases the list is currently asking for; Load more asks for ten more.
    const [releaseLimit, setReleaseLimit] = useState(RCLONE_RELEASES_SHOWN)

    const downloadedQuery = useQuery({
        queryKey: ['rclone', 'downloaded'],
        queryFn: listDownloadedVersions,
    })
    const releasesQuery = useQuery({
        queryKey: ['rclone', 'releases', releaseLimit],
        queryFn: () => fetchAvailableVersions(releaseLimit),
        staleTime: 60 * 60 * 1000,
        retry: 1,
        placeholderData: (previous) => previous,
    })
    const systemQuery = useQuery({
        queryKey: ['rclone', 'system'],
        queryFn: findSystemRclone,
    })
    const systemVersionQuery = useQuery({
        queryKey: ['rclone', 'system-version', systemQuery.data],
        queryFn: () => validateRcloneBinary(systemQuery.data!),
        enabled: !!systemQuery.data,
    })
    const classificationQuery = useQuery({
        queryKey: ['rclone', 'classify', rclonePath],
        queryFn: () => (rclonePath ? classifyRclonePath(rclonePath) : null),
        enabled: !!rclonePath,
    })

    const active = classificationQuery.data

    const invalidateActive = () => {
        queryClient.invalidateQueries({ queryKey: ['rclone'] })
    }

    const downloadMutation = useMutation({
        mutationFn: async (version: string) => {
            return await downloadVersion(version, (p) =>
                setProgress((prev) => ({ ...prev, [version]: p }))
            )
        },
        onSettled: (_data, _err, version) => {
            setProgress((prev) => {
                const next = { ...prev }
                delete next[version]
                return next
            })
            queryClient.invalidateQueries({ queryKey: ['rclone', 'downloaded'] })
        },
        onError: async (e) => {
            await message(`Download failed: ${formatErrorMessage(e, String(e))}`, {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    const activateMutation = useMutation({
        mutationFn: async (opts: { path: string; isSystem?: boolean }) => {
            return await activateRclonePath(opts.path)
        },
        onSuccess: () => invalidateActive(),
    })

    const deleteMutation = useMutation({
        mutationFn: deleteVersion,
        onSettled: () => queryClient.invalidateQueries({ queryKey: ['rclone', 'downloaded'] }),
        onError: async (e) => {
            await message(`Could not delete: ${formatErrorMessage(e, String(e))}`, {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    // Only the active version is in use: nothing else picks a binary of its own any more — a
    // scheduled run goes to the daemon the server is running, like everything else — and the
    // active one has no delete button to begin with.
    const handleDeleteVersion = (v: DownloadedVersion) => deleteMutation.mutate(v.version)

    const downloadedVersions = downloadedQuery.data ?? []
    const downloadedSet = useMemo(
        () => new Set(downloadedVersions.map((v) => v.version)),
        [downloadedVersions]
    )
    const availableToDownload = (releasesQuery.data ?? []).filter(
        (r) => !downloadedSet.has(r.version)
    )

    // A full page came back, so the list was cut off and there may be more behind it. A short one
    // is the end of what GitHub has above the version floor. While a bigger page is on its way the
    // rows are still the previous one, so the button stays and spins rather than blinking out.
    const mayHaveMore =
        releasesQuery.isPlaceholderData || (releasesQuery.data?.length ?? 0) >= releaseLimit
    const latestVersion = releasesQuery.data?.[0]?.version
    const updateAvailable =
        active?.kind === 'managed' &&
        active.version &&
        latestVersion &&
        !downloadedSet.has(latestVersion) &&
        active.version !== latestVersion

    return (
        <>
            <SettingsGroup title="Custom binary">
                <CustomBinaryRow
                    active={active}
                    systemPath={systemQuery.data ?? null}
                    rclonePath={rclonePath}
                    onActivated={invalidateActive}
                />
            </SettingsGroup>

            <SettingsGroup title="Integration" contentClassName="gap-6">
                <PathIntegrationRow
                    rclonePath={rclonePath}
                    isSystemActive={active?.kind === 'system'}
                />
            </SettingsGroup>

            <SettingsGroup title="Updates">
                <AutoUpdateRow />
            </SettingsGroup>

            <SettingsGroup title="Versions">
                <div className="flex flex-col overflow-hidden border divide-y rounded-large border-divider divide-divider">
                    {/* System */}
                    {systemQuery.data && (
                        <VersionRow
                            label={
                                systemVersionQuery.data
                                    ? `System — v${systemVersionQuery.data}`
                                    : 'System'
                            }
                            sublabel={systemQuery.data}
                            warning={subFloorWarning(systemVersionQuery.data)}
                            isActive={active?.kind === 'system'}
                            actionLabel="Use"
                            isActivating={activateMutation.isPending}
                            onActivate={() =>
                                activateMutation.mutate({
                                    path: systemQuery.data!,
                                    isSystem: true,
                                })
                            }
                        />
                    )}

                    {/* Downloaded (managed) */}
                    {downloadedVersions.map((v) => {
                        const isActive = active?.kind === 'managed' && active.version === v.version
                        return (
                            <VersionRow
                                key={v.path}
                                label={`v${v.version}`}
                                sublabel={formatBytes(v.sizeBytes)}
                                warning={subFloorWarning(v.version)}
                                isActive={isActive}
                                actionLabel="Use"
                                isActivating={activateMutation.isPending}
                                onActivate={() => activateMutation.mutate({ path: v.path })}
                                onDelete={isActive ? undefined : () => handleDeleteVersion(v)}
                                isDeleting={
                                    deleteMutation.isPending &&
                                    deleteMutation.variables === v.version
                                }
                            />
                        )
                    })}

                    {/* Available to download */}
                    {availableToDownload.map((r) => {
                        const prog = progress[r.version]
                        const percent = prog?.total
                            ? Math.min(100, Math.round((prog.downloaded / prog.total) * 100))
                            : undefined
                        const isDownloading =
                            downloadMutation.isPending && downloadMutation.variables === r.version
                        return (
                            <div key={r.version} className="flex items-center gap-3 px-4 py-3">
                                <div className="flex flex-col flex-1 min-w-0">
                                    <span className="text-sm text-neutral-500">v{r.version}</span>
                                    {isDownloading && (
                                        <Progress
                                            aria-label="download progress"
                                            size="sm"
                                            value={percent ?? 0}
                                            isIndeterminate={percent === undefined}
                                            className="mt-1 max-w-52"
                                        />
                                    )}
                                </div>
                                <Button
                                    size="sm"
                                    variant="light"
                                    isIconOnly={true}
                                    isLoading={isDownloading}
                                    onPress={() => downloadMutation.mutate(r.version)}
                                    data-focus-visible="false"
                                >
                                    <DownloadIcon className="w-4 h-4" />
                                </Button>
                            </div>
                        )
                    })}

                    {(downloadedVersions.length > 0 || systemQuery.data) &&
                        availableToDownload.length === 0 &&
                        releasesQuery.isError && (
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

                    {releasesQuery.isLoading && downloadedVersions.length === 0 && (
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

                {updateAvailable && (
                    <div className="flex items-center gap-2">
                        <Chip size="sm" color="primary" variant="flat">
                            Update available: v{latestVersion}
                        </Chip>
                        <Button
                            size="sm"
                            color="primary"
                            variant="flat"
                            isLoading={
                                downloadMutation.isPending &&
                                downloadMutation.variables === latestVersion
                            }
                            onPress={async () => {
                                const path = await downloadMutation.mutateAsync(latestVersion!)
                                activateMutation.mutate({ path })
                            }}
                            data-focus-visible="false"
                        >
                            Update &amp; use
                        </Button>
                    </div>
                )}
            </SettingsGroup>
        </>
    )
}

function VersionRow({
    label,
    sublabel,
    warning,
    isActive,
    actionLabel,
    onActivate,
    isActivating,
    onDelete,
    isDeleting,
}: {
    label: string
    sublabel: string
    warning?: string | null
    isActive: boolean
    actionLabel: string
    onActivate: () => void
    isActivating?: boolean
    onDelete?: () => void
    isDeleting?: boolean
}) {
    return (
        <div className="flex items-center gap-3 px-4 py-3">
            <HardDriveIcon className="w-4 h-4 text-neutral-500 shrink-0" />
            <div className="flex flex-col flex-1 min-w-0">
                <span className="text-sm font-medium">{label}</span>
                <span className="text-xs truncate text-neutral-500">{sublabel}</span>
                {warning && <span className="text-xs text-warning">{warning}</span>}
            </div>
            {isActive ? (
                <Chip size="sm" color="success" variant="flat">
                    ACTIVE
                </Chip>
            ) : (
                <Button
                    size="sm"
                    variant="flat"
                    isLoading={isActivating}
                    onPress={onActivate}
                    data-focus-visible="false"
                >
                    {actionLabel}
                </Button>
            )}
            {onDelete ? (
                <Button
                    size="sm"
                    variant="light"
                    isIconOnly={true}
                    color="danger"
                    isLoading={isDeleting}
                    onPress={onDelete}
                    data-focus-visible="false"
                >
                    <Trash2Icon className="w-4 h-4" />
                </Button>
            ) : (
                <Tooltip content="Can't delete the active version" isDisabled={!isActive}>
                    <span className="inline-flex">
                        <Button size="sm" variant="light" isIconOnly={true} isDisabled={true}>
                            <Trash2Icon className="w-4 h-4" />
                        </Button>
                    </span>
                </Tooltip>
            )}
        </div>
    )
}

function CustomBinaryRow({
    active,
    systemPath,
    rclonePath,
    onActivated,
}: {
    active: { kind: string; version: string | null } | null | undefined
    systemPath: string | null
    rclonePath: string | undefined
    onActivated: () => void
}) {
    const isCustomActive = active?.kind === 'custom'
    const [value, setValue] = useState('')

    // Seed with the current custom path, else the detected system rclone.
    useEffect(() => {
        setValue(isCustomActive && rclonePath ? rclonePath : (systemPath ?? ''))
    }, [isCustomActive, rclonePath, systemPath])

    const customVersionQuery = useQuery({
        queryKey: ['rclone', 'custom-version', rclonePath],
        queryFn: () => validateRcloneBinary(rclonePath!),
        enabled: isCustomActive && !!rclonePath,
    })
    const customWarning = isCustomActive ? subFloorWarning(customVersionQuery.data) : null

    const useMutationState = useMutation({
        mutationFn: async (path: string) => {
            const version = await probeRcloneBinaryOrThrow(path)
            const ok = await activateRclonePath(path)
            return { version, ok }
        },
        onSuccess: () => onActivated(),
        onError: async (e) => {
            await reportError(e, { title: 'Invalid binary', fallback: String(e), capture: false })
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
            // Picking a binary implies using it — activate immediately, no separate button.
            useMutationState.mutate(selected)
        }
    }

    return (
        <div className="flex flex-col gap-2">
            <Input
                value={value}
                onValueChange={setValue}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && value) {
                        useMutationState.mutate(value)
                    }
                }}
                size="lg"
                placeholder="Point to an rclone binary on your machine (/path/to/rclone)"
                autoComplete="off"
                endContent={
                    useMutationState.isPending ? (
                        <Spinner size="sm" />
                    ) : (
                        <button
                            type="button"
                            onClick={browse}
                            className="transition-colors text-neutral-400 hover:text-neutral-200"
                        >
                            <FolderOpenIcon className="w-5 h-5" />
                        </button>
                    )
                }
            />
            {isCustomActive && (
                <span className="text-xs text-success">
                    Currently using a custom binary
                    {customVersionQuery.data ? ` (v${customVersionQuery.data})` : ''}.
                </span>
            )}
            {customWarning && <span className="text-xs text-warning">{customWarning}</span>}
        </div>
    )
}

function AutoUpdateRow() {
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
                Applies to versions installed by the app. When off, you'll be notified when a new
                version is available.
            </span>
        </div>
    )
}

function PathIntegrationRow({
    rclonePath,
    isSystemActive,
}: {
    rclonePath: string | undefined
    isSystemActive: boolean
}) {
    const queryClient = useQueryClient()
    const statusQuery = useQuery({
        queryKey: ['rclone', 'path-integration'],
        queryFn: getPathIntegration,
    })

    const toggleMutation = useMutation({
        mutationFn: async (enable: boolean) => {
            if (!rclonePath) throw new Error('No active rclone to link.')
            return await setPathIntegration(enable, rclonePath)
        },
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: ['rclone', 'path-integration'] }),
        onError: async (e) => {
            await reportError(e, { title: 'PATH integration', fallback: String(e), capture: false })
            queryClient.invalidateQueries({ queryKey: ['rclone', 'path-integration'] })
        },
    })

    const status = statusQuery.data

    return (
        <div className="flex flex-col gap-2">
            <Checkbox
                isSelected={status?.enabled ?? false}
                isDisabled={
                    toggleMutation.isPending ||
                    statusQuery.isLoading ||
                    isSystemActive ||
                    !rclonePath
                }
                onValueChange={(checked) => toggleMutation.mutate(checked)}
            >
                Add rclone to PATH
            </Checkbox>
            <span className="text-xs text-neutral-500">
                Lets you call rclone from your terminal.
            </span>
            {isSystemActive && (
                <span className="text-xs text-neutral-500">
                    The system rclone is already on your PATH.
                </span>
            )}
            {status?.warning && !isSystemActive && (
                <span className="text-xs text-warning">{status.warning}</span>
            )}
        </div>
    )
}

// One rclone process shares these across every transfer, so they are set here and not per
// transfer. Bandwidth can be changed on a running rclone; the two transaction limits are read
// once, when it starts.
function LimitsSettings() {
    const limits = useHostStore((state) => state.limits)
    const managed = useQuery({ queryKey: ['server', 'status'], queryFn: status }).data?.managedDaemon
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
    const tpsChanged = tpsLimit.trim() !== shown.tpsLimit || tpsLimitBurst.trim() !== shown.tpsLimitBurst

    const save = async () => {
        setIsSaving(true)
        try {
            const saved = useHostStore.getState().limits
            const next = {
                bwLimit: saved?.bwLimit ?? '',
                tpsLimit: saved?.tpsLimit ?? 0,
                tpsLimitBurst: saved?.tpsLimitBurst ?? 0,
            }
            if (bwChanged) {
                // Applied to the running rclone at once, which is also what checks the syntax.
                try {
                    await rclone('/core/bwlimit' as any, {
                        params: { query: { rate: bwLimit.trim() || 'off' } },
                    })
                } catch (error) {
                    await message(formatErrorMessage(error), {
                        title: 'Bandwidth limit not accepted',
                        kind: 'error',
                    })
                    return
                }
                next.bwLimit = bwLimit.trim()
                useHostStore.setState({ limits: { ...next } })
            }
            if (!tpsChanged) return
            if (await isRcloneBusy()) {
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
            next.tpsLimit = tps
            next.tpsLimitBurst = tps > 0 ? burst : 0
            useHostStore.setState({ limits: next })
            await restartActiveRclone()
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
                isDisabled={isSaving || !!tpsProblem || !!burstProblem || (!bwChanged && !tpsChanged)}
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
            await rpc<string>('test_proxy_connection', { proxyUrl: url })

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
