import { GLOSS, TONE_GRADIENT, type Tone } from './tones'

export function toneButton(tone: Tone): string {
    return `bg-linear-to-b text-white ${GLOSS} ${TONE_GRADIENT[tone]}`
}
