import type { Tone } from '../../components/look/tones'
import { routeOf } from '../../routes'
import type { Guide } from './types'

export function toneOf(guide: Guide): Tone {
    return (guide.open && routeOf(guide.open.route).def?.look?.tone) || 'blue'
}
