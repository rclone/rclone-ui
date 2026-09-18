import { Button, Checkbox, Chip, Input, Progress, Spinner, Tooltip } from '@heroui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
    DownloadIcon,
    FolderOpenIcon,
    HardDriveIcon,
    RefreshCwIcon,
    Trash2Icon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { message, pickPath } from '../../../lib/api/dialog'
import { useCapabilities, mode } from '../../../lib/api/host'
import { formatErrorMessage, reportError } from '../../../lib/errors'
import { formatBytes } from '../../../lib/format'
import {
    classifyRclonePath,
    compareVersions,
    findSystemRclone,
    probeRcloneBinaryOrThrow,
    resolveActiveConfigPath,
    validateRcloneBinary,
} from '../../../lib/rclone/common'
import {
    MIN_RCLONE_VERSION,
    RCLONE_RELEASES_STEP,
    releasesShown,
} from '../../../lib/rclone/constants'
import {
    type DownloadProgress,
    type DownloadedVersion,
    activateRclonePath,
    deleteVersion,
    downloadVersion,
    fetchAvailableVersions,
    getConfigSync,
    getPathIntegration,
    listDownloadedVersions,
    setConfigSync,
    setPathIntegration,
    withConfigSyncLock,
} from '../../../lib/rclone/versions'
import { flushHostStore, useHostStore } from '../../../store/host'
import { usePersistedStore } from '../../../store/persisted'
import BaseSection from './BaseSection'
import SettingsGroup, { type SettingsLayout } from './SettingsGroup'

/** Warning for binaries below the version floor the app's Serve feature needs. */
function subFloorWarning(version: string | null | undefined): string | null {
    if (!version) return null
    return compareVersions(version, MIN_RCLONE_VERSION) < 0
        ? `Serve requires rclone ≥ ${MIN_RCLONE_VERSION.split('.').slice(0, 2).join('.')}`
        : null
}

// The desktop keeps this as its own tab; the browser folds it into the Rclone screen next to the
// proxy settings, which is why the groups take their layout from the caller.
export default function BinarySection() {
    return (
        <BaseSection header={{ title: 'Binary' }} className="pb-10">
            <BinarySettings layout="native" />
        </BaseSection>
    )
}

export function BinarySettings({ layout }: { layout: SettingsLayout }) {
    const caps = useCapabilities()
    const queryClient = useQueryClient()
    const rclonePath = usePersistedStore((state) => state.rclonePath)
    const [progress, setProgress] = useState<Record<string, DownloadProgress>>({})
    // How many releases the list is currently asking for; Load more asks for ten more.
    const [releaseLimit, setReleaseLimit] = useState(releasesShown(mode))

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
            return await activateRclonePath(opts.path, { offerSystemConfig: opts.isSystem })
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

    const scheduledTasks = useHostStore((state) => state.scheduledTasks)

    const handleDeleteVersion = async (v: DownloadedVersion) => {
        // Schedules can pin a specific downloaded version by absolute path — deleting it would
        // make every later run fail with "binary not found". Being the active global binary is
        // not the only way a version can be in use. (Schedules are local-host-only, so the host
        // store is authoritative here.)
        const pinnedBy = scheduledTasks.filter((task) => task.binaryPath === v.path)
        if (pinnedBy.length > 0) {
            const names = pinnedBy.map((task) => task.name || task.operation).join(', ')
            await message(
                `This version is used by ${pinnedBy.length} scheduled task(s): ${names}. Change their rclone binary in the schedule settings first.`,
                { title: 'Version in use', kind: 'warning' }
            )
            return
        }
        deleteMutation.mutate(v.version)
    }

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
                {caps.configSync && <ConfigSyncRow hasSystemRclone={!!systemQuery.data} />}
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

function ConfigSyncRow({ hasSystemRclone }: { hasSystemRclone: boolean }) {
    const queryClient = useQueryClient()
    const activeConfigId = useHostStore((state) => state.activeConfigId)
    const syncIntent = useHostStore((state) => state.syncConfigToSystem)
    const syncMarker = useHostStore((state) => state.syncConfigLinkTarget)
    const setConfigSyncState = useHostStore((state) => state.setConfigSyncState)
    const setDefaultConfigPath = useHostStore((state) => state.setDefaultConfigPath)

    // The active config's on-disk path (the symlink target); re-resolves when the active config changes.
    const configPathQuery = useQuery({
        queryKey: ['rclone', 'active-config-path', activeConfigId],
        queryFn: () => resolveActiveConfigPath(),
    })
    const appConfigPath = configPathQuery.data

    // Shares the PATH-integration cache so this stays in step with the checkbox above.
    const pathQuery = useQuery({
        queryKey: ['rclone', 'path-integration'],
        queryFn: getPathIntegration,
    })
    // Only meaningful if a terminal rclone would read the system config path. But an ALREADY-enabled
    // sync must always be switch-off-able even if availability later disappears (PATH turned off, no
    // system binary) — otherwise the user is stuck with a link they can't remove.
    const available = hasSystemRclone || Boolean(pathQuery.data?.enabled)
    const canToggle = available || syncIntent

    const statusQuery = useQuery({
        queryKey: ['rclone', 'config-sync', appConfigPath, syncMarker],
        queryFn: () => getConfigSync(appConfigPath!, syncMarker),
        enabled: !!appConfigPath,
    })
    const status = statusQuery.data

    const toggleMutation = useMutation({
        // Serialized against reconcile (startup/switch/activation) via the shared config-sync lock, so
        // a toggle and a stale reconcile can't interleave their read→invoke→persist sequences.
        mutationFn: (enable: boolean) =>
            withConfigSyncLock(async () => {
                // Resolve the target fresh INSIDE the lock (a switch just before us may have moved it).
                const path = await resolveActiveConfigPath()
                const host = useHostStore.getState()
                const result = await setConfigSync(
                    enable,
                    path,
                    host.syncConfigLinkTarget,
                    host.defaultConfigPath ?? null
                )
                // If the file we moved aside was the app's own default config, follow it to the
                // relocated copy so switching back to `default` still reads the user's remotes.
                if (result.defaultBackedUp && result.backupPath) {
                    setDefaultConfigPath(result.backupPath)
                }
                // Persist intent + ownership marker together (one store write): the marker is the
                // active path when we now hold a link, else null. Startup reconcile uses these to
                // self-heal. Flush durably so a crash can't desync the store from the on-disk link.
                setConfigSyncState({
                    intent: enable,
                    linkTarget: enable && result.managed ? path : null,
                })
                await flushHostStore()
                return result
            }),
        onSuccess: async (result) => {
            if (result.backupPath) {
                await message(`Your existing rclone config was moved to:\n${result.backupPath}`, {
                    title: 'Config backed up',
                    kind: 'info',
                })
            }
            queryClient.invalidateQueries({ queryKey: ['rclone', 'config-sync'] })
            queryClient.invalidateQueries({ queryKey: ['rclone', 'active-config-path'] })
        },
        onError: async (e) => {
            await reportError(e, { title: 'Config sync', fallback: String(e), capture: false })
            queryClient.invalidateQueries({ queryKey: ['rclone', 'config-sync'] })
        },
    })

    // The checkbox reflects the user's opt-in (persisted intent), not the momentary filesystem state.
    // This keeps the circular/direct-use case honest: it reads "on" only when the user actually
    // enabled sync, so switching to another config then re-points the system path as the UI implied.
    const isSynced = syncIntent
    // Circular/direct-use: the active config IS the system file, so there is no link to manage — but
    // it stays toggleable so the user can opt in (intent) to have the terminal follow future switches.
    const circular = Boolean(status?.enabled && !status?.managed)
    // Intent is on but the link is not currently applied to the active config (drift, or a missing/
    // blocked link) — surface it so the terminal isn't silently left on a different config.
    const notApplied = syncIntent && !!status && !status.enabled && !circular

    return (
        <div className="flex flex-col gap-2">
            <Checkbox
                isSelected={isSynced}
                isDisabled={
                    toggleMutation.isPending ||
                    statusQuery.isLoading ||
                    configPathQuery.isLoading ||
                    !canToggle
                }
                onValueChange={(checked) => toggleMutation.mutate(checked)}
            >
                Sync config
            </Checkbox>
            <span className="text-xs text-neutral-500">
                Keeps your selected config in sync with the system rclone config, so rclone in your
                terminal shares the app's remotes.
            </span>
            {!available && (
                <span className="text-xs text-neutral-500">
                    {syncIntent
                        ? 'No terminal rclone is available right now (system rclone missing and “Add rclone to PATH” is off), so the shell won’t see this config until one is. You can still turn sync off.'
                        : 'Requires a system rclone or “Add rclone to PATH”.'}
                </span>
            )}
            {circular && (
                <span className="text-xs text-neutral-500">
                    The app already uses the system rclone config directly.
                </span>
            )}
            {status?.warning ? (
                <span className="text-xs text-warning">{status.warning}</span>
            ) : notApplied ? (
                <span className="text-xs text-warning">
                    Sync is on, but the system config link isn’t in place yet; it will be re-applied
                    on the next config switch or restart.
                </span>
            ) : null}
        </div>
    )
}
