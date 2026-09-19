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
import { useCapabilities } from '../../../lib/api/host'
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
    listDownloadedVersions,
    setPathIntegration,
} from '../../../lib/rclone/versions'
import { usePersistedStore } from '../../../store/persisted'
import SettingsGroup, { type SettingsLayout } from './SettingsGroup'
import { useHostStore } from '../../../store/host'
import { rpc } from '../../../lib/api/rpc'
import BaseSection from './BaseSection'

// The browser's one screen for the rclone the server runs: which binary, and the proxy it reaches
// the world through. There is no third group for a config file — rclone resolves its own, and the
// file itself is edited from the remotes list.
export default function RcloneSection() {
    return (
        <BaseSection
            header={{ title: 'Rclone' }}
            className="w-full max-w-3xl gap-4 px-6 pb-12 mx-auto"
        >
            <BinarySettings layout="web" />
            <ProxySettings layout="web" />
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

// The binary settings, beside the proxy settings below. The groups still take a layout from the
// caller: `SettingsGroup` renders a tab's right-aligned labels differently from this wide screen.
function BinarySettings({ layout }: { layout: SettingsLayout }) {
    const caps = useCapabilities()
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
            <SettingsGroup layout={layout} title="Custom binary">
                <CustomBinaryRow
                    active={active}
                    systemPath={systemQuery.data ?? null}
                    rclonePath={rclonePath}
                    onActivated={invalidateActive}
                />
            </SettingsGroup>

            <SettingsGroup layout={layout} title="Integration" contentClassName="gap-6">
                {caps.pathIntegration && (
                    <PathIntegrationRow
                        rclonePath={rclonePath}
                        isSystemActive={active?.kind === 'system'}
                    />
                )}
            </SettingsGroup>

            <SettingsGroup layout={layout} title="Updates">
                <AutoUpdateRow />
            </SettingsGroup>

            <SettingsGroup layout={layout} title="Versions">
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

const URL_HINT = 'Set the proxy server URL for network requests'
const IGNORED_HINT = 'Hosts that should bypass the proxy server'

// The proxy half of this screen. The groups still take a layout from the caller: `SettingsGroup`
// renders a tab's right-aligned labels differently from this wide screen.
function ProxySettings({ layout }: { layout: SettingsLayout }) {
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
