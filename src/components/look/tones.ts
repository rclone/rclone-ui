// Each window, each operation and each group of settings has a tone. A tone colors an icon tile,
// and the text, the glow and the main button that go with it. The classes are spelled out per
// tone, because Tailwind only ships the classes it can read.

export const TONE_NAMES = [
    'blue',
    'indigo',
    'violet',
    'fuchsia',
    'pink',
    'red',
    'orange',
    'lime',
    'green',
    'cyan',
    'sky',
    'graphite',
] as const

export type Tone = (typeof TONE_NAMES)[number]

export const TONE_GRADIENT: Record<Tone, string> = {
    blue: 'from-sky-400 to-blue-600',
    indigo: 'from-indigo-400 to-indigo-600',
    violet: 'from-violet-400 to-violet-600',
    fuchsia: 'from-fuchsia-400 to-fuchsia-600',
    pink: 'from-pink-400 to-rose-600',
    red: 'from-red-400 to-red-600',
    orange: 'from-amber-400 to-orange-500',
    lime: 'from-lime-400 to-lime-600',
    green: 'from-emerald-400 to-emerald-600',
    cyan: 'from-cyan-400 to-cyan-600',
    // rclone's own color, between sky and cyan.
    sky: 'from-cyan-400 to-sky-600',
    graphite: 'from-zinc-500 to-zinc-700',
}

export const TONE_TEXT: Record<Tone, string> = {
    blue: 'text-sky-600 dark:text-sky-400',
    indigo: 'text-indigo-600 dark:text-indigo-400',
    violet: 'text-violet-600 dark:text-violet-400',
    fuchsia: 'text-fuchsia-600 dark:text-fuchsia-400',
    pink: 'text-pink-600 dark:text-pink-400',
    red: 'text-red-600 dark:text-red-400',
    orange: 'text-orange-600 dark:text-orange-400',
    lime: 'text-lime-600 dark:text-lime-400',
    green: 'text-emerald-600 dark:text-emerald-400',
    cyan: 'text-cyan-600 dark:text-cyan-400',
    sky: 'text-sky-600 dark:text-sky-400',
    graphite: 'text-zinc-500 dark:text-zinc-400',
}

/** A tone's color as RGB channels ("14 165 233"), for glows: rgb(${TONE_RGB.blue} / 0.2). */
export const TONE_RGB: Record<Tone, string> = {
    blue: '14 165 233',
    indigo: '99 102 241',
    violet: '139 92 246',
    fuchsia: '217 70 239',
    pink: '236 72 153',
    red: '239 68 68',
    orange: '249 115 22',
    lime: '132 204 22',
    green: '16 185 129',
    cyan: '6 182 212',
    sky: '14 165 233',
    graphite: '113 113 122',
}

/** A highlight along the top edge and a small shadow underneath, for a tone-filled surface. */
export const GLOSS = 'shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_1px_2px_rgb(0_0_0/0.15)]'
