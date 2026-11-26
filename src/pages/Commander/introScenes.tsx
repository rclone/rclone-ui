import { cn } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    AngleUpSmall as AngleUpSmallIcon,
    ArrowUpRightSquare as ArrowUpRightSquareIcon,
    ChartColumn as ChartColumnIcon,
    ChartPieSimple as ChartPieSimpleIcon,
    FileText as FileTextIcon,
    Film as FilmIcon,
    FolderArrowDown as FolderArrowDownIcon,
    Folder as FolderIcon,
    Gear as GearIcon,
    HardDrive as HardDriveIcon,
    Pen as PenIcon,
    Repeat as RepeatIcon,
    Star as StarIcon,
} from '@zappicon/react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { type ComponentType, type ReactNode, useEffect, useState } from 'react'
import { formatBytes, formatDate } from '../../../lib/format'
import { platform } from '../../../lib/shell'
import BackendIcon from '../../components/BackendIcon'

function usePhase(times: readonly number[], still: number): number {
    const reduce = useReducedMotion()
    const [phase, setPhase] = useState(0)
    useEffect(() => {
        if (reduce) return
        const timer = setTimeout(() => setPhase((p) => (p + 1) % times.length), times[phase])
        return () => clearTimeout(timer)
    }, [phase, times, reduce])
    return reduce ? still : phase
}

type Kind = 'folder' | 'video' | 'sheet' | 'text'

interface Row {
    name: string
    kind: Kind
    size?: number
    modified: string
    measured?: number
}

const KIND: Record<Kind, { icon: ComponentType<{ className?: string }>; color: string }> = {
    folder: { icon: FolderIcon, color: 'text-warning' },
    video: { icon: FilmIcon, color: 'text-danger' },
    sheet: { icon: ChartColumnIcon, color: 'text-success' },
    text: { icon: FileTextIcon, color: 'text-default-500' },
}

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB

const DRIVE: Row[] = [
    { name: 'Photos', kind: 'folder', modified: '2026-03-04' },
    { name: 'Contracts', kind: 'folder', modified: '2026-02-18' },
    { name: 'budget.xlsx', kind: 'sheet', size: 48 * KB, modified: '2026-02-11' },
    { name: 'launch.mp4', kind: 'video', size: 212 * MB, modified: '2026-01-30' },
    { name: 'notes.txt', kind: 'text', size: 3 * KB, modified: '2026-01-09' },
]

const BACKUPS: Row[] = [
    { name: 'Archive', kind: 'folder', modified: '2025-12-02', measured: 3.4 * GB },
    { name: 'Taxes', kind: 'folder', modified: '2025-11-27', measured: 18 * MB },
    { name: 'readme.txt', kind: 'text', size: 1 * KB, modified: '2025-11-20' },
]

const PICKED = ['Photos', 'launch.mp4']
const COPIED = [...DRIVE.filter((row) => PICKED.includes(row.name)), ...BACKUPS]

interface Place {
    label: string
    icon: ReactNode
}

function usePlaces(): Place[] {
    return [
        {
            label: t`Favorites`,
            icon: <StarIcon variant="filled" className="text-warning size-3.5" />,
        },
        { label: 'gdrive', icon: <BackendIcon type="drive" className="size-3.5" /> },
        { label: 'media', icon: <BackendIcon type="s3" className="size-3.5" /> },
        { label: 'Backups', icon: <FolderIcon className="text-warning size-3.5" /> },
    ]
}
const DRIVE_PLACE = 1
const BACKUPS_PLACE = 3

function backupDisk(): { path: string; system: string } {
    switch (platform()) {
        case 'windows':
            return { path: 'D:\\', system: 'C:\\' }
        case 'macos':
            return { path: '/Volumes/Backup', system: '/' }
        default:
            return { path: '/mnt/backup', system: '/' }
    }
}

function Pointer({ pressed = false, carrying }: { pressed?: boolean; carrying?: string }) {
    return (
        <motion.span
            layoutId="pointer"
            transition={{ type: 'spring', stiffness: 160, damping: 22 }}
            className="absolute z-30 pointer-events-none left-1/2 top-1/2"
        >
            <svg
                viewBox="0 0 16 16"
                className={cn(
                    'size-4 drop-shadow-md transition-transform duration-150 origin-top-left',
                    pressed && 'scale-90'
                )}
            >
                <path
                    d="M2.5 1.5v11.2l3-2.7 2.1 4.6 2-.9-2.1-4.5h4.1z"
                    fill="white"
                    stroke="black"
                    strokeWidth="1"
                    strokeLinejoin="round"
                />
            </svg>
            {carrying && (
                <span className="absolute px-1.5 py-0.5 font-medium rounded shadow-md whitespace-nowrap left-3 top-3 bg-primary text-primary-foreground">
                    {carrying}
                </span>
            )}
        </motion.span>
    )
}

function Window({ children, bar }: { children: ReactNode; bar?: ReactNode }) {
    return (
        <div className="relative flex flex-col h-full overflow-hidden text-[10px] leading-none border shadow-sm rounded-xl bg-content1 border-divider dark:border-white/10">
            <div className="flex flex-1 min-h-0">{children}</div>
            {bar ?? <Bar />}
        </div>
    )
}

function Divider() {
    return <span className="w-px shrink-0 bg-divider dark:bg-white/10" />
}

function Panel({
    side,
    at,
    rows,
    picked = [],
    fresh = [],
    target = false,
    names = false,
    sizes = false,
    disk = false,
    pointer,
}: {
    side: 'left' | 'right'
    at: number | null
    rows: Row[]
    picked?: string[]
    fresh?: string[]
    target?: boolean
    names?: boolean
    sizes?: boolean
    disk?: boolean
    pointer?: { on: number | string | 'list'; is: ReactNode }
}) {
    const on = pointer?.on
    const places = usePlaces()
    const shown: Place[] = disk
        ? [
              ...places,
              {
                  label: backupDisk().path,
                  icon: <HardDriveIcon className="text-default-500 size-3.5" />,
              },
          ]
        : places
    return (
        <div className={cn('relative flex flex-1 min-w-0', side === 'right' && 'flex-row-reverse')}>
            <div className="z-10 flex flex-col items-center gap-1.5 py-2 w-9 shrink-0 bg-default-50 dark:bg-white/[0.02]">
                {shown.map((place, i) => (
                    <motion.span
                        key={place.label}
                        initial={i >= places.length ? { opacity: 0, scale: 0.6 } : false}
                        animate={{ opacity: 1, scale: 1 }}
                        className={cn(
                            'relative flex items-center justify-center rounded-md size-6 transition-colors duration-300',
                            i === at &&
                                'bg-content1 shadow-sm ring-1 ring-default-300 dark:bg-white/10 dark:ring-white/15'
                        )}
                    >
                        {place.icon}
                        <AnimatePresence>
                            {names && (
                                <motion.span
                                    initial={{ opacity: 0, x: side === 'left' ? -4 : 4 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.15, delay: i * 0.03 }}
                                    className={cn(
                                        'absolute px-1.5 py-1 font-medium rounded whitespace-nowrap bg-foreground text-background',
                                        side === 'left' ? 'left-7' : 'right-7'
                                    )}
                                >
                                    {place.label}
                                </motion.span>
                            )}
                        </AnimatePresence>
                        {on === i && pointer?.is}
                    </motion.span>
                ))}
            </div>
            <div className="relative flex flex-col flex-1 min-w-0">
                <div className="flex items-center gap-1 px-2 font-medium border-b h-6 shrink-0 border-divider dark:border-white/10">
                    {at !== null && (
                        <>
                            {places[at].icon}
                            <span className="truncate">{places[at].label}</span>
                        </>
                    )}
                </div>
                <div className="flex items-center gap-2 px-2 font-medium h-5 shrink-0 text-default-500 bg-default-50 dark:bg-white/[0.02]">
                    <span className="flex-1">{t`Name`}</span>
                    <span className="hidden w-12 text-right sm:inline">{t`Size`}</span>
                    <span className="hidden w-12 sm:inline">{t`Modified`}</span>
                </div>
                <ul className="relative flex flex-col flex-1 gap-0.5 p-1">
                    {rows.length === 0 && (
                        <li className="m-auto text-default-400">
                            <Trans>Pick a place in the sidebar</Trans>
                        </li>
                    )}
                    {rows.map((row, i) => {
                        const { icon: Icon, color } = KIND[row.kind]
                        return (
                            <motion.li
                                key={row.name}
                                initial={{ opacity: 0, y: 3 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.2, delay: i * 0.05 }}
                                className={cn(
                                    'relative flex items-center gap-2 px-1 rounded h-5 shrink-0 transition-colors duration-500',
                                    picked.includes(row.name) &&
                                        'bg-primary/15 text-primary-700 dark:text-primary-300',
                                    fresh.includes(row.name) && 'bg-success/15'
                                )}
                            >
                                <span className="flex items-center flex-1 min-w-0 gap-1.5">
                                    <Icon className={cn('size-3 shrink-0', color)} />
                                    <span className="truncate">{row.name}</span>
                                </span>
                                <span className="hidden w-12 text-right whitespace-nowrap sm:inline text-default-500 tabular-nums">
                                    {sizes && row.measured !== undefined ? (
                                        <motion.span
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            {formatBytes(row.measured)}
                                        </motion.span>
                                    ) : (
                                        row.size !== undefined && formatBytes(row.size)
                                    )}
                                </span>
                                <span className="hidden w-12 truncate sm:inline text-default-500">
                                    {formatDate(row.modified, { month: 'short', day: 'numeric' })}
                                </span>
                                {on === row.name && pointer?.is}
                            </motion.li>
                        )
                    })}
                    {on === 'list' && pointer?.is}
                </ul>
                <AnimatePresence>
                    {target && at !== null && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                            className="absolute inset-0 z-10 flex items-end justify-center pb-4 pointer-events-none ring-2 ring-inset ring-primary bg-primary/5"
                        >
                            <DropHint folder={places[at].label} />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    )
}

function DropHint({ folder }: { folder: string }) {
    return (
        <span className="flex items-center gap-1 px-2 py-1 rounded-full shadow-md bg-content1">
            <FolderArrowDownIcon className="size-3 shrink-0 text-primary" />
            <span>
                <Trans>
                    Drop into <span className="font-semibold">{folder}</span>
                </Trans>
            </span>
        </span>
    )
}

function Bar({ pointer }: { pointer?: ReactNode }) {
    return (
        <div className="flex items-center justify-between h-6 px-2 border-t shrink-0 border-divider dark:border-white/10 text-default-500">
            <span className="flex items-center gap-2">
                <span className="relative flex">
                    <GearIcon className="size-3" />
                    {pointer}
                </span>
                <span className="w-px h-3 bg-divider dark:bg-white/10" />
                <PenIcon className="size-3" />
                <RepeatIcon className="size-3" />
                <ChartPieSimpleIcon className="size-3" />
            </span>
            <span className="flex items-center gap-2">
                <span>
                    <Trans>No active transfers</Trans>
                </span>
                <ArrowUpRightSquareIcon className="size-3" />
                <AngleUpSmallIcon className="size-3" />
            </span>
        </div>
    )
}

function Stage({ id, children }: { id: string; children: ReactNode }) {
    return (
        <LayoutGroup id={id}>
            <div className="relative h-full">{children}</div>
        </LayoutGroup>
    )
}

const PLACES_TIMES = [900, 1400, 1400, 2600]

export function PlacesScene() {
    const phase = usePhase(PLACES_TIMES, 3)
    const pointer = <Pointer />
    return (
        <Stage id="places">
            <Window>
                <Panel
                    side="left"
                    at={phase >= 1 ? DRIVE_PLACE : null}
                    rows={phase >= 1 ? DRIVE : []}
                    pointer={phase === 1 ? { on: DRIVE_PLACE, is: pointer } : undefined}
                />
                <Divider />
                <Panel
                    side="right"
                    at={phase >= 2 ? BACKUPS_PLACE : null}
                    rows={phase >= 2 ? BACKUPS : []}
                    sizes={true}
                    pointer={phase === 2 ? { on: BACKUPS_PLACE, is: pointer } : undefined}
                />
            </Window>
            {(phase === 0 || phase === 3) && (
                <span className="absolute left-1/2 top-[62%]">{pointer}</span>
            )}
        </Stage>
    )
}

const DRAG_TIMES = [1000, 500, 1200, 1800, 1800]

export function DragScene() {
    const phase = usePhase(DRAG_TIMES, 3)
    const count = PICKED.length
    const carrying =
        phase === 1 || phase === 2 ? plural(count, { one: '# item', other: '# items' }) : undefined
    const pointer = <Pointer pressed={phase === 1 || phase === 2} carrying={carrying} />
    return (
        <Stage id="drag">
            <Window>
                <Panel
                    side="left"
                    at={DRIVE_PLACE}
                    rows={DRIVE}
                    picked={phase < 4 ? PICKED : []}
                    pointer={phase <= 1 ? { on: 'Photos', is: pointer } : undefined}
                />
                <Divider />
                <Panel
                    side="right"
                    at={BACKUPS_PLACE}
                    rows={phase === 4 ? COPIED : BACKUPS}
                    fresh={phase === 4 ? PICKED : []}
                    target={phase === 2}
                    sizes={true}
                    pointer={phase === 2 ? { on: 'list', is: pointer } : undefined}
                />
            </Window>
            <AnimatePresence>
                {phase === 3 && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 z-20 flex items-center justify-center text-[10px] leading-none rounded-xl bg-black/10 dark:bg-black/40"
                    >
                        <motion.div
                            initial={{ scale: 0.95 }}
                            animate={{ scale: 1 }}
                            className="flex flex-col gap-2 p-3 rounded-lg shadow-lg w-48 bg-content1 ring-1 ring-divider dark:ring-white/10"
                        >
                            <span className="text-[11px] font-semibold">
                                {plural(count, { one: 'Copy # item', other: 'Copy # items' })}
                            </span>
                            <Choice on={true} label={t`Copy`} hint={t`Keep original files`} />
                            <Choice on={false} label={t`Move`} hint={t`Delete after transfer`} />
                            <span className="flex justify-end gap-1.5 pt-1">
                                <span className="px-2 py-1 rounded bg-default-100">{t`Cancel`}</span>
                                <span className="relative px-2 py-1 font-medium rounded bg-primary text-primary-foreground">
                                    {t`Copy`}
                                    {pointer}
                                </span>
                            </span>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </Stage>
    )
}

function Choice({ on, label, hint }: { on: boolean; label: string; hint: string }) {
    return (
        <span className="flex items-start gap-1.5">
            <span
                className={cn(
                    'flex items-center justify-center mt-px border rounded-full size-3 shrink-0',
                    on ? 'border-primary' : 'border-default-400'
                )}
            >
                {on && <span className="rounded-full size-1.5 bg-primary" />}
            </span>
            <span className="flex flex-col gap-0.5">
                <span className="font-medium">{label}</span>
                <span className="text-default-500">{hint}</span>
            </span>
        </span>
    )
}

const KEYS_TIMES = [1200, 2200, 900]

export function KeysScene() {
    const phase = usePhase(KEYS_TIMES, 1)
    const down = phase === 1
    return (
        <Stage id="keys">
            <Window>
                <Panel side="left" at={DRIVE_PLACE} rows={DRIVE} names={down} />
                <Divider />
                <Panel side="right" at={BACKUPS_PLACE} rows={BACKUPS} names={down} sizes={true} />
            </Window>
            <span className="absolute -translate-x-1/2 left-1/2 bottom-9">
                <kbd
                    className={cn(
                        'flex items-center px-4 py-2 font-sans text-[11px] font-medium rounded-lg ring-1 transition-all duration-100',
                        'bg-content1 ring-default-300 dark:ring-white/20',
                        down
                            ? 'translate-y-0.5 shadow-none bg-default-100 dark:bg-white/10'
                            : 'shadow-[0_3px_0_0_rgb(0_0_0/0.18)]'
                    )}
                >
                    ⇧ {t({ message: 'Shift', comment: 'The Shift key on the keyboard.' })}
                </kbd>
            </span>
        </Stage>
    )
}

const SETTINGS_TIMES = [900, 600, 1100, 2600]

export function SettingsScene() {
    const phase = usePhase(SETTINGS_TIMES, 3)
    const added = phase === 3
    const pointer = <Pointer pressed={phase === 1} />
    const disk = backupDisk()
    return (
        <Stage id="settings">
            <Window bar={<Bar pointer={phase === 1 ? pointer : undefined} />}>
                <Panel side="left" at={DRIVE_PLACE} rows={DRIVE} disk={added} />
                <Divider />
                <Panel side="right" at={BACKUPS_PLACE} rows={BACKUPS} sizes={true} disk={added} />
                <AnimatePresence>
                    {phase >= 2 && (
                        <motion.div
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 4 }}
                            transition={{ duration: 0.15 }}
                            className="absolute z-20 flex flex-col gap-1.5 p-2.5 rounded-lg shadow-lg w-48 left-1.5 bottom-7 bg-content1 ring-1 ring-divider dark:ring-white/10"
                        >
                            <span className="flex items-center gap-2">
                                <span className="flex-1 font-medium">{t`Local folder sizes`}</span>
                                <Toggle on={true} />
                            </span>
                            <span className="flex items-center gap-2 pb-2 mb-0.5 border-b border-divider dark:border-white/10">
                                <span className="flex-1 font-medium">{t`File dates`}</span>
                                <Toggle on={false} />
                            </span>
                            <span className="font-medium">
                                {t({
                                    message: 'Shortcuts',
                                    comment:
                                        'The disks and folders that the sidebars offer, not keyboard shortcuts.',
                                })}
                            </span>
                            {[
                                { path: disk.system, on: true, pointer: undefined },
                                { path: disk.path, on: added, pointer },
                            ].map((shortcut) => (
                                <span key={shortcut.path} className="flex items-center gap-1.5">
                                    <HardDriveIcon className="size-3 shrink-0 text-default-500" />
                                    <span className="flex-1 truncate">{shortcut.path}</span>
                                    <Toggle
                                        on={shortcut.on}
                                        pointer={phase === 2 ? shortcut.pointer : undefined}
                                    />
                                </span>
                            ))}
                        </motion.div>
                    )}
                </AnimatePresence>
            </Window>
            {phase === 0 && <span className="absolute left-[40%] top-[45%]">{pointer}</span>}
            {phase === 3 && <span className="absolute left-[30%] top-[70%]">{pointer}</span>}
        </Stage>
    )
}

function Toggle({ on, pointer }: { on: boolean; pointer?: ReactNode }) {
    return (
        <span
            className={cn(
                'relative flex items-center w-6 h-3.5 p-0.5 rounded-full shrink-0 transition-colors duration-200',
                on ? 'bg-primary' : 'bg-default-300 dark:bg-white/20'
            )}
        >
            <span
                className={cn(
                    'rounded-full shadow size-2.5 bg-white transition-transform duration-200',
                    on && 'translate-x-2.5'
                )}
            />
            {pointer}
        </span>
    )
}
