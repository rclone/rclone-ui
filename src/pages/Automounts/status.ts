import { plural, t } from '@lingui/core/macro'
import type { Mounts } from '../../../lib/core/types'
import type { StatusKind } from '../../components/look/Status'
import { sourceOf } from './source'

type Automount = Mounts.AutomountRow

export interface Status {
    label: string
    kind: StatusKind
}

/**
 * The status on an automount's row. A missing remote comes first, because the automount can't
 * mount until the remote is back.
 */
export function statusOf(a: Pick<Automount, 'mountId' | 'remoteMissing'>): Status {
    if (a.remoteMissing) return { label: t`Remote missing`, kind: 'warning' }
    if (a.mountId) return { label: t`Mounted`, kind: 'success' }
    return { label: t`Not mounted`, kind: 'idle' }
}

/** Reports whether the row offers "Mount now". */
export function canMountNow(a: Pick<Automount, 'enabled' | 'mountId' | 'remoteMissing'>): boolean {
    return a.enabled && !a.mountId && !a.remoteMissing
}

export function deleteQuestion(a: Pick<Automount, 'remote' | 'remotePath'>): string {
    const source = sourceOf(a)
    return t`Delete the automount of ${source}? A mount it started keeps running.`
}

export function searchFields(a: Automount): string[] {
    return [sourceOf(a), a.mountPoint]
}

/** The line under the window's title. */
export function summaryOf(automounts: readonly Automount[]): string {
    const mounted = automounts.filter((a) => a.mountId).length
    const off = automounts.filter((a) => !a.enabled).length
    const missing = automounts.filter((a) => a.remoteMissing).length
    const total = automounts.length
    const parts = [
        plural(mounted, {
            one: `# of ${total} mounted.`,
            other: `# of ${total} mounted.`,
        }),
    ]
    if (off > 0) {
        parts.push(
            t({
                message: plural(off, { one: '# off.', other: '# off.' }),
                comment: 'How many automounts are turned off, as in "1 of 2 mounted. 1 off."',
            })
        )
    }
    if (missing > 0) {
        parts.push(
            plural(missing, { one: '# remote is missing.', other: '# remotes are missing.' })
        )
    }
    return parts.join(' ')
}
