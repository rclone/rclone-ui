import { GLOSS, TONE_GRADIENT, type Tone } from './tones'

/**
 * Classes that draw a HeroUI Button in a tone, such as Sync's start button in green and Delete's
 * in red.
 */
export function toneButton(tone: Tone): string {
    return `bg-linear-to-b text-white ${GLOSS} ${TONE_GRADIENT[tone]}`
}
