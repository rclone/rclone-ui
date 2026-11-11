import { cn } from '@heroui/react'
import { Check as CheckIcon } from '@zappicon/react'
import { IconTile } from '../../components/look/IconTile'
import { SURFACE, SURFACE_HOVER } from '../../components/look/Panel'
import { TONE_GRADIENT, TONE_RGB, type Tone } from '../../components/look/tones'
import type { Choice } from './flow'

/** The tone of a choice that has none of its own. */
const NEUTRAL: Tone = 'blue'

export default function OptionCards<K extends string>({
    labelledBy,
    choices,
    value,
    onPick,
}: {
    labelledBy: string
    choices: Choice<K>[]
    value?: K
    onPick: (key: K) => void
}) {
    return (
        <fieldset aria-labelledby={labelledBy} className="grid min-w-0 grid-cols-2 gap-3">
            {choices.map((choice) => {
                const picked = choice.key === value
                const tone = choice.tone ?? NEUTRAL
                return (
                    <button
                        key={choice.key}
                        type="button"
                        aria-pressed={picked}
                        onClick={() => onPick(choice.key)}
                        style={{ '--pick': TONE_RGB[tone] } as React.CSSProperties}
                        className={cn(
                            SURFACE,
                            'relative flex items-start gap-3.5 p-4 text-left outline-none',
                            'transition-[translate,scale,box-shadow] duration-150 ease-out',
                            'hover:-translate-y-0.5 active:scale-[0.97] motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100',
                            'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                            SURFACE_HOVER,
                            picked &&
                                'shadow-[0_0_0_2px_rgb(var(--pick)),0_8px_20px_-8px_rgb(var(--pick)/0.5)] hover:shadow-[0_0_0_2px_rgb(var(--pick)),0_12px_24px_-8px_rgb(var(--pick)/0.55)] dark:shadow-[0_0_0_2px_rgb(var(--pick)),0_8px_20px_-8px_rgb(var(--pick)/0.6)] dark:hover:shadow-[0_0_0_2px_rgb(var(--pick)),0_12px_24px_-8px_rgb(var(--pick)/0.7)]'
                        )}
                    >
                        {choice.icon && <IconTile icon={choice.icon} tone={tone} size="lg" />}
                        <span className="flex flex-col flex-1 min-w-0 gap-0.5 pr-5">
                            <span className="font-semibold leading-snug">{choice.title}</span>
                            <span className="leading-snug text-small text-default-500 text-pretty">
                                {choice.description}
                            </span>
                        </span>
                        <span
                            aria-hidden={true}
                            className={cn(
                                'absolute grid rounded-full top-3 right-3 size-5 place-items-center',
                                picked
                                    ? `bg-linear-to-b text-white ${TONE_GRADIENT[tone]}`
                                    : 'ring-1 ring-inset ring-default-300 dark:ring-default-200'
                            )}
                        >
                            {picked && <CheckIcon className="size-3.5" />}
                        </span>
                    </button>
                )
            })}
        </fieldset>
    )
}
