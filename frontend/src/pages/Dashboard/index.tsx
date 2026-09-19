import { Button, Chip, Progress, cn } from '@heroui/react'
import { useQueries, useQuery } from '@tanstack/react-query'
import cronstrue from 'cronstrue'
import { ArrowRightIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { reconnectCheckQueryOptions } from '../../../lib/rclone/reconnect'
import RemotesReconnectDrawer from '../../components/RemotesReconnectDrawer'
import { Link } from 'react-router-dom'
import { status as fetchStatus } from '../../../lib/api/app'
import { useLifecyclePhase } from '../../../lib/api/lifecycle'
import { buildReadablePathMultiple, formatBytes } from '../../../lib/format'
import { fetchMountList, fetchServeList } from '../../../lib/rclone/api'
import rclone from '../../../lib/rclone/client'
import { daemonVersionQueryOptions } from '../../../lib/hooks'
import { ENDED, type TransferRow, totalsOf } from '../../../lib/transfers/rows'
import { useTransferRows } from '../../../lib/transfers/useTransferRows'
import { useHostStore } from '../../../store/host'
import { usePersistedStore } from '../../../store/persisted'
import OperationGrid from '../../components/OperationGrid'
import Onboarding from './Onboarding'
import { Eyebrow, Figure, MoreLink, Panel } from './primitives'

// The browser's home page: what this rclone is doing right now. The throughput trace is the
// page's thesis (rclone exists to move bytes); everything else is a quiet inventory with one
// click into the page that owns it.

const SAMPLES = 60
/** What Moved / Files / Errors cover. */
const TOTALS_WINDOW_MS = 24 * 60 * 60 * 1000
const SAMPLE_MS = 1000

interface CoreStats {
    speed?: number
    bytes?: number
    errors?: number
    transfers?: number
    checks?: number
    elapsedTime?: number
    transferring?: unknown[]
    checking?: string[]
}

function formatSpeed(bytesPerSecond: number): string {
    return `${formatBytes(bytesPerSecond)}/s`
}

function formatUptime(seconds: number): string {
    if (seconds < 60) return 'just started'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `up ${minutes} min`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `up ${hours} h ${minutes % 60} min`
    return `up ${Math.floor(hours / 24)} d`
}

/** Where a transfer stands, in a word or two. */
function standing(row: TransferRow): string {
    const state =
        row.state !== 'running'
            ? ENDED[row.state].label
            : row.phase === 'preparing' && row.listed > 0
              ? `Preparing · ${row.listed.toLocaleString()} listed`
              : row.phase === 'preparing'
                ? 'Preparing'
                : row.phase === 'checking'
                  ? 'Checking'
                  : 'Running'
    return row.scheduled ? `${state} · Scheduled` : state
}

function relativeTime(iso?: string): string {
    if (!iso) return ''
    const delta = Math.max(0, Date.now() - new Date(iso).getTime())
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} h ago`
    return `${Math.floor(hours / 24)} d ago`
}

function describeCron(cron: string): string {
    try {
        return cronstrue.toString(cron, { verbose: false })
    } catch {
        return cron
    }
}

/** A rolling window of the last `SAMPLES` throughput readings, one per poll. */
function useThroughputTrace(stats: CoreStats | undefined, updatedAt: number) {
    const samples = useRef<number[]>(Array(SAMPLES).fill(0))
    const lastStamp = useRef(0)
    const [, bump] = useState(0)
    useEffect(() => {
        if (!stats || updatedAt === lastStamp.current) return
        lastStamp.current = updatedAt
        samples.current = [...samples.current.slice(1), Math.max(0, stats.speed ?? 0)]
        bump((n) => n + 1)
    }, [stats, updatedAt])
    return samples.current
}

function Sparkline({ samples, live }: { samples: number[]; live: boolean }) {
    const width = 600
    const height = 140
    const peak = Math.max(...samples, 1)
    const step = width / (samples.length - 1)
    const points = samples.map((value, index) => {
        const x = index * step
        const y = height - (value / peak) * (height - 12) - 4
        return [x, y] as const
    })
    const line = points
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
        .join(' ')
    const area = `${line} L${width},${height} L0,${height} Z`
    return (
        <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="w-full h-full"
            aria-hidden="true"
        >
            {[0.25, 0.5, 0.75].map((fraction) => (
                <line
                    key={fraction}
                    x1={0}
                    x2={width}
                    y1={height * fraction}
                    y2={height * fraction}
                    className="stroke-default-200 dark:stroke-neutral-800"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                />
            ))}
            <path
                d={area}
                className={cn(
                    'fill-primary/15',
                    !live && 'fill-default-200/60 dark:fill-neutral-800/40'
                )}
            />
            <path
                d={line}
                fill="none"
                className={cn(
                    'stroke-primary',
                    !live && 'stroke-default-400 dark:stroke-neutral-600'
                )}
                strokeWidth={2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    )
}

const PHASE_CHIP: Record<
    string,
    { label: string; color: 'success' | 'warning' | 'danger' | 'default' }
> = {
    ready: { label: 'Ready', color: 'success' },
    starting: { label: 'Starting', color: 'warning' },
    resolving: { label: 'Finding rclone', color: 'warning' },
    downloading: { label: 'Downloading rclone', color: 'warning' },
    updating: { label: 'Updating rclone', color: 'warning' },
    failed: { label: 'Failed to start', color: 'danger' },
    stopped: { label: 'Stopped', color: 'default' },
}

/** What is running, in the smallest voice the page has: reference, not news. */
function Versions({ cloud, rclone }: { cloud?: string; rclone?: string }) {
    const known = rclone && rclone !== 'unknown' ? rclone : undefined
    const parts = [cloud && `cloud ${cloud}`, known && `rclone ${known}`].filter(Boolean)
    if (parts.length === 0) return null
    return <footer className="pt-1 text-xs text-center text-default-400">{parts.join(' · ')}</footer>
}

export default function Dashboard() {
    const phase = useLifecyclePhase()
    const server = useQuery({
        queryKey: ['server', 'status'],
        queryFn: fetchStatus,
        refetchInterval: 30_000,
    })

    // An external daemon publishes no lifecycle phase, so its version comes from rclone itself.
    const daemonVersion = useQuery(daemonVersionQueryOptions())

    const stats = useQuery({
        queryKey: ['dashboard', 'stats'],
        queryFn: async () => (await rclone('/core/stats')) as CoreStats,
        refetchInterval: SAMPLE_MS,
        retry: 1,
    })
    const remotes = useQuery({
        queryKey: ['dashboard', 'remotes'],
        queryFn: async () => {
            const dump = (await rclone('/config/dump')) as Record<
                string,
                { type?: string; token?: string }
            >
            return Object.entries(dump ?? {})
                .map(([name, config]) => ({
                    name,
                    type: config?.type ?? 'unknown',
                    // Only a remote holding a token can have one that expired; checking an s3 or
                    // an sftp costs a connection that could never answer with this.
                    hasToken: !!config?.token,
                }))
                .sort((a, b) => a.name.localeCompare(b.name))
        },
        retry: 1,
    })
    // Asked quietly as the page opens, one per remote that holds a token and cached for the day:
    // a remote whose sign-in has lapsed is invisible until something touches it, which is how it
    // goes unnoticed for weeks.
    const tokenRemotes = (remotes.data ?? []).filter((remote) => remote.hasToken)
    const checks = useQueries({
        queries: tokenRemotes.map((remote) => reconnectCheckQueryOptions(remote.name)),
    })
    const staleRemotes = tokenRemotes.filter(
        (_, index) => checks[index]?.data === 'needs-reconnect'
    )
    const [reconnectOpen, setReconnectOpen] = useState(false)

    // The transfers panel is the record's newest few, the running ones with their live numbers:
    // there after a restart, there from the moment one starts, and never a download (which is
    // not a transfer, and would show in rclone's daemon-wide files in flight).
    const { rows } = useTransferRows()
    const all = useMemo(() => [...rows.active, ...rows.inactive], [rows])
    const recent = all.slice(0, 6)
    // Moved, files and errors are the record's too, over a window that says what it is. They
    // were rclone's daemon-wide counters, which take in every file the daemon touches: saving
    // rclone.conf was "1 file moved".
    const totals = useMemo(() => totalsOf(all, Date.now() - TOTALS_WINDOW_MS), [all])
    const mounts = useQuery({
        queryKey: ['mounts', 'dashboard'],
        queryFn: fetchMountList,
        refetchInterval: 15_000,
    })
    const serves = useQuery({
        queryKey: ['serves', 'dashboard'],
        queryFn: fetchServeList,
        refetchInterval: 15_000,
    })
    const schedules = useHostStore((state) => state.scheduledTasks)
    const onboardingDismissed = usePersistedStore((state) => state.onboarding.dismissed)

    const samples = useThroughputTrace(stats.data, stats.dataUpdatedAt)
    const transferring = stats.data?.transferring ?? []
    const live = transferring.length > 0 || (stats.data?.speed ?? 0) > 0
    const speed = stats.data?.speed ?? 0
    const unreachable = stats.isError
    const chip = phase ? PHASE_CHIP[phase.phase] : undefined
    const rcloneVersion =
        (phase?.phase === 'ready' && phase.version) || daemonVersion.data
    const mountRows = useMemo(
        () => ((mounts.data ?? []) as { Fs: string; MountPoint: string }[]).slice(0, 4),
        [mounts.data]
    )
    const serveRows = useMemo(
        () =>
            (
                (serves.data ?? []) as {
                    id: string
                    addr: string
                    params?: { type?: string; fs?: string }
                }[]
            ).slice(0, 4),
        [serves.data]
    )
    const enabledSchedules = schedules.filter((task) => task.isEnabled)

    return (
        <div className="flex flex-col gap-5 p-6 pb-10 lg:p-8">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
                <div className="flex items-center gap-2">
                    {server.data ? (
                        <Chip
                            variant="flat"
                            size="sm"
                            className="font-medium uppercase tracking-wide"
                        >
                            {formatUptime(server.data.uptimeSeconds)}
                        </Chip>
                    ) : null}
                    {unreachable ? (
                        <Chip
                            color="danger"
                            variant="flat"
                            size="sm"
                            className="font-medium uppercase tracking-wide"
                        >
                            rclone unreachable
                        </Chip>
                    ) : chip ? (
                        <Chip
                            color={chip.color}
                            variant="flat"
                            size="sm"
                            className="font-medium uppercase tracking-wide"
                        >
                            {chip.label}
                        </Chip>
                    ) : null}
                </div>
            </header>

            <Panel className="p-0 overflow-hidden">
                <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr]">
                    <div className="flex flex-col justify-between gap-5 p-5 border-b border-divider lg:border-b-0 lg:border-r dark:border-neutral-800">
                        <Eyebrow>Throughput · last 60 s</Eyebrow>
                        <div>
                            <div
                                className={cn(
                                    'text-4xl font-semibold leading-none tracking-tight lg:text-5xl',
                                    live && 'font-mono tabular-nums'
                                )}
                            >
                                {unreachable ? '—' : live ? formatSpeed(speed) : 'Idle'}
                            </div>
                            <p className="mt-2 text-sm text-default-500">
                                {unreachable
                                    ? 'rclone is not answering.'
                                    : live
                                      ? `${transferring.length} file${transferring.length === 1 ? '' : 's'} moving`
                                      : 'Nothing is moving.'}
                            </p>
                        </div>
                        <div>
                            {/* The figures under it are transfers on record, over this window. */}
                            <Eyebrow>Transfers · last 24 hours</Eyebrow>
                            <dl className="grid grid-cols-3 gap-3 text-xs">
                                <div>
                                    <dt className="text-default-500">Moved</dt>
                                    <dd>
                                        <Figure value={formatBytes(totals.bytes)} />
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-default-500">Files</dt>
                                    <dd>
                                        <Figure value={totals.files} />
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-default-500">Errors</dt>
                                    <dd>
                                        <Figure
                                            value={totals.errors}
                                            className={cn(totals.errors > 0 && 'text-danger')}
                                        />
                                    </dd>
                                </div>
                            </dl>
                        </div>
                    </div>
                    <div className="relative min-h-[160px] lg:min-h-0">
                        <div className="absolute inset-0">
                            <Sparkline samples={samples} live={live} />
                        </div>
                        {live && (
                            <div className="absolute flex items-center gap-2 text-[11px] text-default-500 top-4 right-5">
                                <span className="font-mono tabular-nums">
                                    peak {formatSpeed(Math.max(...samples))}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            </Panel>

            {onboardingDismissed ? (
                <>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <Panel>
                            <Eyebrow right={<MoreLink to="/settings?tab=remotes">Manage</MoreLink>}>
                                Remotes · {remotes.data?.length ?? '–'}
                            </Eyebrow>
                            {/* Its own row rather than the eyebrow: this card is a quarter of the
                                grid, and a chip beside the label pushes the count onto a second
                                line. Full width also suits a warning better than a chip does. */}
                            {staleRemotes.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setReconnectOpen(true)}
                                    className="flex items-center w-full gap-2 px-2.5 py-2 mb-2.5 text-left rounded-lg outline-none transition-colors bg-warning-50 text-warning-700 hover:bg-warning-100 dark:bg-warning-500/10 dark:text-warning-400 dark:hover:bg-warning-500/20 focus-visible:ring-2 focus-visible:ring-warning"
                                >
                                    <TriangleAlertIcon className="size-3.5 shrink-0" />
                                    <span className="text-xs font-medium">
                                        {staleRemotes.length === 1
                                            ? '1 needs reconnecting'
                                            : `${staleRemotes.length} need reconnecting`}
                                    </span>
                                    <ArrowRightIcon className="w-3 h-3 ml-auto shrink-0" />
                                </button>
                            )}
                            {remotes.data && remotes.data.length > 0 ? (
                                <ul className="flex flex-col gap-1.5">
                                    {remotes.data.slice(0, 5).map((remote) => (
                                        <li key={remote.name}>
                                            <Link
                                                to={`/commander?path=${encodeURIComponent(`${remote.name}:`)}`}
                                                className="flex items-center gap-2.5 py-1 -mx-2 px-2 rounded-lg outline-none hover:bg-default-100 dark:hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-primary"
                                            >
                                                <img
                                                    src={`/icons/backends/${remote.type}.png`}
                                                    alt=""
                                                    className="w-5 h-5 rounded"
                                                    onError={(event) => {
                                                        event.currentTarget.style.visibility =
                                                            'hidden'
                                                    }}
                                                />
                                                <span className="text-sm truncate">
                                                    {remote.name}
                                                </span>
                                                <span className="ml-auto text-xs text-default-500">
                                                    {remote.type}
                                                </span>
                                            </Link>
                                        </li>
                                    ))}
                                    {remotes.data.length > 5 && (
                                        <li className="pt-1 text-xs text-default-500">
                                            +{remotes.data.length - 5} more
                                        </li>
                                    )}
                                </ul>
                            ) : (
                                <p className="text-sm text-default-500">
                                    {remotes.isPending
                                        ? 'Loading…'
                                        : 'No remotes yet. Add one in Settings.'}
                                </p>
                            )}
                        </Panel>

                        <Panel>
                            <Eyebrow right={<MoreLink to="/mount">New mount</MoreLink>}>
                                Mounts · {mounts.data ? (mounts.data as unknown[]).length : '–'}
                            </Eyebrow>
                            {mountRows.length > 0 ? (
                                <ul className="flex flex-col gap-2">
                                    {mountRows.map((mount) => (
                                        <li
                                            key={mount.MountPoint}
                                            className="flex flex-col text-sm"
                                        >
                                            <span className="truncate">{mount.Fs}</span>
                                            <span className="font-mono text-xs truncate text-default-500">
                                                {mount.MountPoint}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-default-500">Nothing mounted.</p>
                            )}
                        </Panel>

                        <Panel>
                            <Eyebrow right={<MoreLink to="/serve">New serve</MoreLink>}>
                                Serves · {serves.data ? (serves.data as unknown[]).length : '–'}
                            </Eyebrow>
                            {serveRows.length > 0 ? (
                                <ul className="flex flex-col gap-2">
                                    {serveRows.map((serve) => (
                                        <li key={serve.id} className="flex flex-col text-sm">
                                            <span className="truncate">
                                                <span className="uppercase text-default-500">
                                                    {serve.params?.type}
                                                </span>{' '}
                                                · {serve.params?.fs}
                                            </span>
                                            <span className="font-mono text-xs truncate text-default-500">
                                                {serve.addr}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-default-500">Nothing served.</p>
                            )}
                        </Panel>

                        <Panel>
                            <Eyebrow right={<MoreLink to="/schedules">All</MoreLink>}>
                                Schedules · {enabledSchedules.length}
                            </Eyebrow>
                            {schedules.length > 0 ? (
                                <ul className="flex flex-col gap-2">
                                    {schedules.slice(0, 4).map((task) => (
                                        <li key={task.id} className="flex flex-col text-sm">
                                            <span
                                                className={cn(
                                                    'truncate',
                                                    !task.isEnabled &&
                                                        'text-default-500 line-through'
                                                )}
                                            >
                                                {task.name ?? task.operation}
                                            </span>
                                            <span className="text-xs truncate text-default-500">
                                                {describeCron(task.cron)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-default-500">
                                    No operations currently scheduled.
                                </p>
                            )}
                        </Panel>
                    </div>

                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
                        <Panel>
                            <Eyebrow right={<MoreLink to="/transfers">All transfers</MoreLink>}>
                                {rows.active.length > 0 ? 'Transfers · live' : 'Transfers · recent'}
                            </Eyebrow>
                            {recent.length > 0 ? (
                                <ul className="flex flex-col divide-y divide-divider dark:divide-neutral-800">
                                    {recent.map((row) => {
                                        const isRunning = row.state === 'running'
                                        const name =
                                            buildReadablePathMultiple(row.sources, 'short', true) ||
                                            row.operation
                                        return (
                                            <li key={row.id} className="flex flex-col gap-1.5 py-2">
                                                <div className="flex items-baseline gap-3 text-sm">
                                                    <span
                                                        className="truncate"
                                                        title={row.sources.join(', ')}
                                                    >
                                                        {name}
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            'text-xs truncate',
                                                            row.state === 'failed'
                                                                ? 'text-danger'
                                                                : 'text-default-500'
                                                        )}
                                                    >
                                                        {standing(row)}
                                                    </span>
                                                    <Figure
                                                        className="ml-auto text-xs whitespace-nowrap"
                                                        value={
                                                            isRunning
                                                                ? row.totalBytes > 0
                                                                    ? `${formatBytes(row.bytes)} / ${formatBytes(row.totalBytes)} · ${formatSpeed(row.speed)}`
                                                                    : ''
                                                                : [
                                                                      formatBytes(row.bytes),
                                                                      relativeTime(
                                                                          row.finishedAt ?? row.ts
                                                                      ),
                                                                  ]
                                                                      .filter(Boolean)
                                                                      .join(' · ')
                                                        }
                                                    />
                                                </div>
                                                {isRunning && (
                                                    <Progress
                                                        aria-label={`${name} ${row.progress}%`}
                                                        value={row.progress}
                                                        // Nothing to measure against until rclone
                                                        // has sized it.
                                                        isIndeterminate={row.totalBytes === 0}
                                                        size="sm"
                                                        color="primary"
                                                        classNames={{
                                                            track: 'bg-default-200 dark:bg-neutral-800',
                                                        }}
                                                    />
                                                )}
                                            </li>
                                        )
                                    })}
                                </ul>
                            ) : (
                                <div className="flex flex-col items-start gap-3 py-2">
                                    <p className="text-sm text-default-500">
                                        {unreachable
                                            ? 'rclone is not answering.'
                                            : 'Nothing is moving right now.'}
                                    </p>
                                    {!unreachable && (
                                        <div className="flex gap-2">
                                            <Button
                                                as={Link}
                                                to="/copy"
                                                size="sm"
                                                color="primary"
                                                variant="flat"
                                            >
                                                Start a copy
                                            </Button>
                                            <Button as={Link} to="/sync" size="sm" variant="flat">
                                                Start a sync
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </Panel>

                        <Panel>
                            <Eyebrow>Start</Eyebrow>
                            <OperationGrid />
                            <Button
                                as={Link}
                                to="/wizard"
                                className="mt-3"
                                fullWidth={true}
                                color="primary"
                                endContent={<ArrowRightIcon className="w-4 h-4" />}
                            >
                                Not sure? Open Wizard
                            </Button>
                        </Panel>
                    </div>
                </>
            ) : (
                <Onboarding
                    hasRemotes={(remotes.data?.length ?? 0) > 0}
                    // A transfer on record, and nothing less: rclone's own counter takes in
                    // every file the daemon touches, a saved rclone.conf included.
                    hasTransferred={all.some((row) => !row.isDryRun)}
                />
            )}

            <Versions cloud={server.data?.version} rclone={rcloneVersion} />

            <RemotesReconnectDrawer
                isOpen={reconnectOpen}
                onClose={() => setReconnectOpen(false)}
                remotes={staleRemotes}
            />
        </div>
    )
}
