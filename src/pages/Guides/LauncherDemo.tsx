import { cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Search as SearchIcon } from '@zappicon/react'
import { useReducedMotion } from 'framer-motion'
import { useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { launcher } from '../../../lib/shell'
import { IconTile } from '../../components/look/IconTile'
import { TONE_RGB } from '../../components/look/tones'
import { WINDOWS } from '../../routes'
import { guideById } from './guides'
import { KeyboardContext, Keys } from './text'
import { toneOf } from './tones'

/**
 * What the demo types, and the launcher's top result for it, as the launcher's own entries name
 * them (app/launcher/engine/providers/navigation.go). Each result's look is its guide's.
 */
const DEMO = [
    {
        query: t({
            message: 'schedule',
            comment: 'Typed into the launcher in a demo. Use words that find the Schedules window.',
        }),
        title: WINDOWS.schedules.title,
        subtitle: t`Open the Schedules screen.`,
        guide: 'schedules',
    },
    {
        query: t({
            message: 'keep in sync',
            comment: 'Typed into the launcher in a demo. Use words that find the Watchers window.',
        }),
        title: WINDOWS.watchers.title,
        subtitle: t`Open the Watchers screen.`,
        guide: 'watchers',
    },
    {
        query: t({
            message: 'commander',
            comment: 'Typed into the launcher in a demo. Use words that find the Commander window.',
        }),
        title: WINDOWS.commander.title,
        subtitle: t`Open the Commander screen.`,
        guide: 'commander',
    },
    {
        query: t({
            message: 'mount at login',
            comment:
                'Typed into the launcher in a demo. Use words that find the Automounts window.',
        }),
        title: WINDOWS.automounts.title,
        subtitle: t`Open the Automounts screen.`,
        guide: 'automounts',
    },
]

type Phase = 'type' | 'hold' | 'erase'

/** How long each phase waits before its next step, in ms. */
const TYPE_MS = 70
const HOLD_MS = 2200
const ERASE_MS = 26
const NEXT_MS = 380

/** Whether the window is on screen. The demo stops typing while it isn't. */
function useVisible(): boolean {
    return useSyncExternalStore(
        (changed) => {
            document.addEventListener('visibilitychange', changed)
            return () => document.removeEventListener('visibilitychange', changed)
        },
        () => document.visibilityState === 'visible'
    )
}

/**
 * Types each query of DEMO, holds it, and erases it, in a loop. With reduced motion it shows the
 * first query, typed. The result shows once half the query is in, as the launcher's would.
 */
function useTyping() {
    const still = useReducedMotion() ?? false
    const visible = useVisible()
    const [index, setIndex] = useState(0)
    const [typed, setTyped] = useState(0)
    const [phase, setPhase] = useState<Phase>('type')
    const item = DEMO[index]

    useEffect(() => {
        if (still || !visible) return
        const q = item.query
        let wait: number
        let step: () => void
        if (phase === 'type' && typed < q.length) {
            // A little unevenness, so it reads as typing rather than a ticker.
            wait = TYPE_MS + ((typed * 37) % 45)
            step = () => setTyped(typed + 1)
        } else if (phase === 'type') {
            wait = 0
            step = () => setPhase('hold')
        } else if (phase === 'hold') {
            wait = HOLD_MS
            step = () => setPhase('erase')
        } else if (typed > 0) {
            wait = ERASE_MS
            step = () => setTyped(typed - 1)
        } else {
            wait = NEXT_MS
            step = () => {
                setIndex((index + 1) % DEMO.length)
                setPhase('type')
            }
        }
        const timer = window.setTimeout(step, wait)
        return () => window.clearTimeout(timer)
    }, [still, visible, item, index, typed, phase])

    const shown = still ? item.query.length : typed
    return {
        item,
        text: item.query.slice(0, shown),
        found: shown >= Math.ceil(item.query.length / 2),
    }
}

/**
 * The launcher, typing what a user would type and showing what it finds. It teaches the one
 * thing to remember: most things start in the launcher. Clicking it opens the real one.
 */
export function LauncherDemo() {
    const { shortcut } = useContext(KeyboardContext)
    const { item, text, found } = useTyping()
    const guide = guideById(item.guide)
    const tone = guide ? toneOf(guide) : 'graphite'

    return (
        <div className="relative isolate">
            {/* The groups' colors, glowing behind the launcher. */}
            <div
                aria-hidden={true}
                className="absolute -z-10 -inset-x-8 -inset-y-10 opacity-60 blur-2xl dark:opacity-90"
                style={{
                    background: [
                        `radial-gradient(30% 60% at 10% 35%, rgb(${TONE_RGB.blue} / 0.7), transparent 70%)`,
                        `radial-gradient(30% 60% at 32% 85%, rgb(${TONE_RGB.green} / 0.55), transparent 70%)`,
                        `radial-gradient(30% 60% at 55% 15%, rgb(${TONE_RGB.orange} / 0.5), transparent 70%)`,
                        `radial-gradient(30% 60% at 78% 85%, rgb(${TONE_RGB.violet} / 0.65), transparent 70%)`,
                        `radial-gradient(30% 60% at 94% 30%, rgb(${TONE_RGB.pink} / 0.55), transparent 70%)`,
                    ].join(', '),
                }}
            />
            <button
                type="button"
                aria-label={t`Open the launcher`}
                onClick={() => launcher.show()}
                className={cn(
                    'block w-full overflow-hidden text-left outline-none rounded-2xl bg-content1',
                    'shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_2px_4px_rgb(0_0_0/0.04),0_12px_32px_-8px_rgb(0_0_0/0.18)]',
                    'dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_12px_32px_-8px_rgb(0_0_0/0.7)]',
                    'transition-shadow duration-150 ease-out focus-visible:ring-2 focus-visible:ring-primary',
                    'hover:shadow-[0_0_0_1px_rgb(0_0_0/0.12),0_2px_4px_rgb(0_0_0/0.04),0_16px_40px_-8px_rgb(0_0_0/0.22)]',
                    'dark:hover:shadow-[0_0_0_1px_rgb(255_255_255/0.18),0_16px_40px_-8px_rgb(0_0_0/0.8)]'
                )}
            >
                <span aria-hidden={true} className="flex items-center gap-3 px-4 h-14">
                    <SearchIcon className="size-5 shrink-0 text-default-400" />
                    <span className="flex items-center flex-1 min-w-0 text-lg">
                        <span className="truncate">{text}</span>
                        <span className="ml-px h-6 w-0.5 shrink-0 rounded-full bg-primary animate-caret motion-reduce:animate-none" />
                    </span>
                    <Keys caps={shortcut} />
                </span>
                <span aria-hidden={true} className="block p-1.5 border-t border-divider">
                    <span
                        className={cn(
                            'flex items-center gap-3 px-2.5 py-2 rounded-[10px] bg-default-100',
                            'transition-[opacity,translate] duration-200 ease-out',
                            found ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
                        )}
                    >
                        {guide && <IconTile icon={guide.icon} tone={tone} size="lg" />}
                        <span className="flex flex-col flex-1 min-w-0">
                            <span className="font-medium leading-snug truncate">{item.title}</span>
                            <span className="leading-snug truncate text-small text-default-500">
                                {item.subtitle}
                            </span>
                        </span>
                        <Keys caps={['↵']} />
                    </span>
                </span>
            </button>
        </div>
    )
}
