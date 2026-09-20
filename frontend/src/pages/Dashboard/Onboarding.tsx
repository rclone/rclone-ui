import { Chip, cn } from '@heroui/react'
import { ArrowRightIcon, CheckIcon, XIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useNotificationTargets } from '@/lib/notifications'
import { useTeam } from '@/lib/team'
import { useSchedules } from '@/lib/scheduler'
import { type OnboardingStep, usePersistedStore } from '@/store'
import { Eyebrow, Panel } from './primitives'

interface Step {
    key: OnboardingStep
    title: string
    description: string
    action: string
    to: string
}

// In the order a first session runs: something to talk to, a look at it, a job, then company.
const STEPS: Step[] = [
    {
        key: 'remote',
        title: 'Add a remote',
        description:
            'Connect a cloud account, a server or a disk. rclone speaks to more than seventy of them.',
        action: 'Add a remote',
        to: '/remotes/new',
    },
    {
        key: 'commander',
        title: 'Browse it in the Commander',
        description: 'Two panels, your files on both sides. Drag between them to copy or move.',
        action: 'Open Commander',
        to: '/commander',
    },
    {
        key: 'transfer',
        title: 'Move some files',
        description:
            'Run a copy or a sync from one place to another and follow it under Transfers.',
        action: 'Start a copy',
        to: '/copy',
    },
    {
        key: 'team',
        title: 'Add a team member',
        description: 'Give a colleague their own sign-in. Admins add members under Settings.',
        action: 'Add a member',
        to: '/settings/team',
    },
]

interface Hint {
    key: 'schedules' | 'notifications' | 'templates'
    title: string
    description: string
    to: string
}

// What the app does past a first transfer. None of these count towards the steps above.
const HINTS: Hint[] = [
    {
        key: 'schedules',
        title: 'Schedules',
        description: 'Run an operation by itself, on a timer.',
        to: '/schedules',
    },
    {
        key: 'notifications',
        title: 'Notifications',
        description: 'Hear when a job finishes or fails.',
        to: '/settings/notifications',
    },
    {
        key: 'templates',
        title: 'Templates',
        description: 'Keep a command’s options to reuse.',
        to: '/templates',
    },
]

const NODE =
    'flex items-center justify-center w-7 h-7 rounded-full shrink-0 text-xs font-semibold tabular-nums'

function DoneChip() {
    return (
        <Chip size="sm" variant="flat" color="success" className="h-5 text-[11px]">
            Done
        </Chip>
    )
}

/**
 * The Dashboard's first-run timeline. Steps tick themselves off from what the page already
 * knows (the daemon's remotes and transfer stats) or from a visit (the Commander marks its own),
 * and stay ticked once recorded. The optional rows under them only reflect what exists now.
 * Dismissing it is for good.
 */
export default function Onboarding({
    hasRemotes,
    hasTransferred,
}: {
    hasRemotes: boolean
    hasTransferred: boolean
}) {
    const completed = usePersistedStore((state) => state.onboarding.completed)
    const completeOnboardingStep = usePersistedStore((state) => state.completeOnboardingStep)
    const dismissOnboarding = usePersistedStore((state) => state.dismissOnboarding)

    // More than one account: someone besides the owner can sign in.
    const hasTeam = (useTeam().data?.length ?? 0) > 1

    useEffect(() => {
        const observed: [OnboardingStep, boolean][] = [
            ['remote', hasRemotes],
            ['transfer', hasTransferred],
            ['team', hasTeam],
        ]
        for (const [step, done] of observed) {
            if (done && !completed.includes(step)) completeOnboardingStep(step)
        }
    }, [hasRemotes, hasTransferred, hasTeam, completed, completeOnboardingStep])

    const hasSchedules = (useSchedules().data?.length ?? 0) > 0
    const hasTemplates = usePersistedStore((state) => state.templates.length > 0)
    const hasTargets = (useNotificationTargets().data?.length ?? 0) > 0
    const hintDone: Record<Hint['key'], boolean> = {
        schedules: hasSchedules,
        notifications: hasTargets,
        templates: hasTemplates,
    }

    const done = STEPS.filter((step) => completed.includes(step.key)).length
    const allDone = done === STEPS.length
    const next = STEPS.find((step) => !completed.includes(step.key))?.key

    return (
        <Panel label="Getting started">
            <Eyebrow
                right={
                    <button
                        type="button"
                        onClick={dismissOnboarding}
                        className="inline-flex items-center gap-1 text-xs text-default-500 rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        Dismiss
                        <XIcon className="w-3 h-3" />
                    </button>
                }
            >
                Getting started · {done} of {STEPS.length} done
            </Eyebrow>
            <p className="mb-5 text-sm text-default-500">
                {allDone
                    ? 'All four done. Everything below is optional.'
                    : 'Four steps to a working setup. Each ticks itself off once you’ve done it.'}
            </p>

            <ol aria-label="Steps" className="flex flex-col">
                {STEPS.map((step, index) => {
                    const isDone = completed.includes(step.key)
                    const isNext = step.key === next
                    const last = index === STEPS.length - 1
                    return (
                        <li key={step.key} className={cn('relative flex gap-4', !last && 'pb-6')}>
                            {!last && (
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        'absolute left-[13px] top-8 bottom-1 w-px',
                                        isDone ? 'bg-primary/40' : 'bg-divider dark:bg-neutral-800'
                                    )}
                                />
                            )}
                            <span
                                aria-hidden="true"
                                className={cn(
                                    NODE,
                                    isDone
                                        ? 'bg-primary text-white'
                                        : isNext
                                          ? 'border-2 border-primary text-primary'
                                          : 'border border-divider text-default-500 dark:border-neutral-700'
                                )}
                            >
                                {isDone ? (
                                    <CheckIcon className="w-4 h-4" strokeWidth={2.5} />
                                ) : (
                                    index + 1
                                )}
                            </span>
                            <div className="flex flex-col flex-1 min-w-0 gap-1 pt-1">
                                <div className="flex items-center gap-2">
                                    <h3
                                        className={cn(
                                            'text-sm font-medium',
                                            isDone && 'text-default-500'
                                        )}
                                    >
                                        {step.title}
                                    </h3>
                                    {isDone && <DoneChip />}
                                </div>
                                {!isDone && (
                                    <p className="text-sm text-default-500">{step.description}</p>
                                )}
                                {!isDone && (
                                    <div className="pt-2">
                                        <Link
                                            to={step.to}
                                            className={cn(
                                                'inline-flex items-center h-8 px-3 text-sm font-medium rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
                                                isNext
                                                    ? 'bg-primary text-white hover:bg-primary-600'
                                                    : 'bg-default-100 text-foreground hover:bg-default-200 dark:bg-white/5 dark:hover:bg-white/10'
                                            )}
                                        >
                                            {step.action}
                                        </Link>
                                    </div>
                                )}
                            </div>
                        </li>
                    )
                })}
            </ol>

            <div className="flex items-center gap-4 mt-7 mb-2">
                <span aria-hidden="true" className="w-7 shrink-0" />
                <span className="text-[11px] font-medium tracking-[0.14em] uppercase text-default-500">
                    Optional
                </span>
            </div>
            <ul aria-label="Optional" className="flex flex-col">
                {HINTS.map((hint) => {
                    const isDone = hintDone[hint.key]
                    return (
                        <li key={hint.key} className="flex items-center gap-4">
                            <span
                                aria-hidden="true"
                                className={cn(
                                    NODE,
                                    isDone
                                        ? 'border border-success text-success'
                                        : 'border border-dashed border-default-300 dark:border-neutral-700'
                                )}
                            >
                                {isDone && <CheckIcon className="w-3.5 h-3.5" strokeWidth={2.5} />}
                            </span>
                            <Link
                                to={hint.to}
                                className="flex items-center flex-1 min-w-0 gap-2 px-2 py-2 -mx-2 text-sm rounded-lg outline-none hover:bg-default-100 dark:hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-primary"
                            >
                                <span className="font-medium">{hint.title}</span>
                                {isDone && <DoneChip />}
                                <span className="truncate text-default-500">
                                    {hint.description}
                                </span>
                                <ArrowRightIcon className="w-3 h-3 ml-auto shrink-0 text-default-500" />
                            </Link>
                        </li>
                    )
                })}
            </ul>
        </Panel>
    )
}
