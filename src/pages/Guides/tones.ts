import type { Tone } from '../../components/look/tones'
import { routeOf } from '../../routes'
import type { Guide } from './types'

/**
 * A guide's tone: the tone of the window it is about, so a guide looks like its window. The
 * launcher has no window, and is blue.
 */
export function toneOf(guide: Guide): Tone {
    return (guide.open && routeOf(guide.open.route).def?.look?.tone) || 'blue'
}
