import { cn } from '@heroui/react'
import type { Choice, Tone } from './flow'

// Spelled out per tone: Tailwind only ships the classes it can read.
const TONES: Record<Tone, { tile: string; picked: string; ring: string }> = {
    primary: {
        tile: 'bg-primary text-primary-foreground',
        picked: 'border-primary bg-primary/5',
        ring: 'focus-visible:ring-primary',
    },
    success: {
        tile: 'bg-success text-success-foreground',
        picked: 'border-success bg-success/5',
        ring: 'focus-visible:ring-success',
    },
    lime: {
        tile: 'bg-lime-500 text-white',
        picked: 'border-lime-500 bg-lime-500/5',
        ring: 'focus-visible:ring-lime-500',
    },
    secondary: {
        tile: 'bg-secondary text-secondary-foreground',
        picked: 'border-secondary bg-secondary/5',
        ring: 'focus-visible:ring-secondary',
    },
    cyan: {
        tile: 'bg-cyan-500 text-white',
        picked: 'border-cyan-500 bg-cyan-500/5',
        ring: 'focus-visible:ring-cyan-500',
    },
    orange: {
        tile: 'bg-orange-500 text-white',
        picked: 'border-orange-500 bg-orange-500/5',
        ring: 'focus-visible:ring-orange-500',
    },
    danger: {
        tile: 'bg-danger text-danger-foreground',
        picked: 'border-danger bg-danger/5',
        ring: 'focus-visible:ring-danger',
    },
}

const NEUTRAL = {
    tile: 'bg-default-100 text-foreground dark:bg-white/5',
    picked: 'border-primary bg-primary/5',
    ring: 'focus-visible:ring-primary',
}

/** The text colour of a tone, for an icon standing on its own. */
export const TONE_TEXT: Record<Tone, string> = {
    primary: 'text-primary',
    success: 'text-success',
    lime: 'text-lime-500',
    secondary: 'text-secondary',
    cyan: 'text-cyan-500',
    orange: 'text-orange-500',
    danger: 'text-danger',
}

/**
 * The Wizard's select-one control: one card per choice, the icon on a tile in the operation's
 * colour, the title with a one-line description under it. A picked card takes that colour on its
 * border and focus ring too. A disabled card says why in place of its description.
 */
export default function OptionCards<K extends string>({
    labelledBy,
    choices,
    value,
    onPick,
    disabled,
}: {
    /** The id of the question heading the group answers. */
    labelledBy: string
    choices: Choice<K>[]
    value?: K
    onPick: (key: K) => void
    /** Why a choice cannot be taken right now, when it cannot. */
    disabled?: (key: K) => string | undefined
}) {
    return (
        <fieldset aria-labelledby={labelledBy} className="grid min-w-0 gap-3 sm:grid-cols-2">
            {choices.map((choice) => {
                const picked = choice.key === value
                const reason = disabled?.(choice.key)
                const Icon = choice.icon
                const tone = choice.tone ? TONES[choice.tone] : NEUTRAL
                return (
                    <button
                        key={choice.key}
                        type="button"
                        aria-pressed={picked}
                        disabled={!!reason}
                        onClick={() => onPick(choice.key)}
                        className={cn(
                            'flex items-start gap-3 p-4 text-left rounded-xl border outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-offset-2',
                            tone.ring,
                            picked
                                ? tone.picked
                                : 'border-divider hover:border-default-400 dark:border-neutral-800 dark:hover:border-neutral-600',
                            reason && 'opacity-50'
                        )}
                    >
                        {Icon && (
                            <span
                                aria-hidden="true"
                                className={cn(
                                    'flex items-center justify-center w-9 h-9 rounded-lg shrink-0',
                                    tone.tile
                                )}
                            >
                                <Icon className="w-4 h-4" strokeWidth={1.75} />
                            </span>
                        )}
                        <span className="flex flex-col min-w-0 gap-0.5">
                            <span className="text-sm font-medium">{choice.title}</span>
                            <span className="text-xs text-default-500">
                                {reason ?? choice.description}
                            </span>
                        </span>
                    </button>
                )
            })}
        </fieldset>
    )
}
