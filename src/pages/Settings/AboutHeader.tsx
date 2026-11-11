import { cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { type CSSProperties, useMemo } from 'react'
import { useAppInfo } from '../../../lib/app'
import { osDetails, shellDetails, version } from '../../../lib/shell'
import { Panel } from '../../components/look/Panel'
import { useLogFiles } from './logs'
import { useUpdates } from './useUpdates'

/** The rclone mark, cut out of the shape it is drawn on. */
export const LOGO_MASK: CSSProperties = {
    maskImage: 'url(/icon.png)',
    maskSize: 'contain',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
}

/**
 * What the app knows about itself: its versions, the OS, and its folders. The header shows the
 * versions, and Help copies all of it into a bug report.
 */
export function useAbout() {
    const infoQuery = useAppInfo()
    const filesQuery = useLogFiles()
    const shellQuery = useQuery({
        queryKey: ['about', 'shell'],
        queryFn: async () => ({
            ui: version(),
            shell: await shellDetails(),
            os: await osDetails(),
        }),
    })

    const debug = useMemo(() => {
        const core = infoQuery.data
        if (!core) return null
        return {
            versions: {
                ui: shellQuery.data?.ui ?? '',
                rclone: core.rcloneVersion,
                go: core.goVersion,
                shell: shellQuery.data?.shell ?? '',
                osFamily: shellQuery.data?.os.family ?? '',
                osVersion: shellQuery.data?.os.version ?? '',
                arch: core.arch,
            },
            paths: {
                data: core.dataDir,
                logs: filesQuery.data?.folder ?? '',
            },
        }
    }, [infoQuery.data, shellQuery.data, filesQuery.data])

    return { debug, logsFile: filesQuery.data?.core, isLoading: infoQuery.isLoading }
}

/** The app's icon: the rclone mark in white on its blue square. Size it with classes. */
function AppIcon({ className }: { className?: string }) {
    return (
        <span
            aria-hidden={true}
            className={cn(
                'grid place-items-center shrink-0 bg-linear-to-b from-[#4c8ad6] to-[#1c4a87]',
                'shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_0_0_1px_rgb(0_0_0/0.08)]',
                className
            )}
        >
            <div className="bg-white" style={LOGO_MASK} />
        </span>
    )
}

export default function AboutHeader() {
    const { debug } = useAbout()
    const updates = useUpdates()
    const v = debug?.versions
    const system = v?.osFamily
        ? `${v.osFamily === 'MacOS' ? 'macOS' : v.osFamily} ${v.osVersion}`
        : ''

    return (
        <Panel className="isolate scroll-mt-5">
            <section id="about" aria-label={t`About Rclone UI`}>
                <div
                    aria-hidden={true}
                    className="absolute inset-0 overflow-hidden rounded-2xl -z-10"
                >
                    <div className="absolute inset-0 bg-[radial-gradient(80%_140%_at_0%_0%,rgb(56_132_220/0.2),transparent_60%),radial-gradient(60%_120%_at_100%_0%,rgb(99_102_241/0.12),transparent_70%)] dark:bg-[radial-gradient(80%_140%_at_0%_0%,rgb(56_132_220/0.28),transparent_60%),radial-gradient(60%_120%_at_100%_0%,rgb(99_102_241/0.18),transparent_70%)]" />
                    <div
                        className="absolute -right-10 -top-14 size-64 rotate-12 bg-[#1c4a87]/[0.06] dark:bg-white/[0.035]"
                        style={LOGO_MASK}
                    />
                </div>

                <div className="flex flex-row flex-wrap items-center px-6 pt-6 pb-5 gap-x-5 gap-y-4">
                    <AppIcon className="size-[72px] rounded-[20px] shadow-[0_12px_32px_-8px_rgb(37_99_235/0.7),inset_0_1px_0_rgb(255_255_255/0.3),0_0_0_1px_rgb(0_0_0/0.08)] [&>div]:size-11" />

                    <div className="flex flex-col flex-1 min-w-48 gap-2">
                        <h1 className="text-[26px] font-semibold leading-none tracking-tight font-rounded">
                            Rclone UI
                        </h1>
                        <dl className="flex flex-row flex-wrap gap-x-5 gap-y-1.5 min-h-9">
                            <Fact label={t`Version`} value={v?.ui} />
                            <Fact label="rclone" value={v?.rclone} />
                            <Fact
                                label={
                                    system ||
                                    t({ message: 'System', context: 'the operating system' })
                                }
                                value={v ? v.arch : undefined}
                            />
                        </dl>
                    </div>

                    {updates.button}
                </div>

                {updates.footer && <div className="border-t border-divider">{updates.footer}</div>}
            </section>
        </Panel>
    )
}

function Fact({ label, value }: { label: string; value: string | undefined }) {
    return (
        <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-default-500">{label}</dt>
            <dd className="font-medium leading-tight text-small tabular-nums">
                {value ?? (
                    <span className="block w-14 h-3.5 mt-0.5 rounded-full bg-default-200/70 animate-pulse motion-reduce:animate-none" />
                )}
            </dd>
        </div>
    )
}
