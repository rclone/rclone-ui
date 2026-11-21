// The History window's tab and search. They are kept in the window's session storage, so a page
// that opens again (as it does for another window's "Show transfer") finds them as they were
// left. A new window starts at All.

import { t } from '@lingui/core/macro'
import type { EndedState } from '../../../lib/transfers/ended'

export type Status = 'all' | 'running' | 'completed' | 'failed' | 'stopped'

interface StatusTab {
    key: Status
    label: string
    /** The title when the tab has no transfers. */
    empty: string
    /** The line under that title, or '' for no line. */
    none: string
    /** The line when no transfer of the tab matches the search. */
    noMatch: (search: string) => string
}

export const STATUSES: StatusTab[] = [
    {
        key: 'all',
        label: t({ message: 'All', context: 'History tab', comment: 'Every transfer.' }),
        empty: t`No transfers`,
        none: '',
        noMatch: (search) => t`Nothing has “${search}” in its ID, paths or error.`,
    },
    {
        key: 'running',
        label: t({
            message: 'Running',
            context: 'History tab',
            comment: 'The transfers that are running.',
        }),
        empty: t`No running transfers`,
        none: t`Nothing is running right now.`,
        noMatch: (search) => t`Nothing running has “${search}” in its ID, paths or error.`,
    },
    {
        key: 'completed',
        label: t({
            message: 'Finished',
            context: 'History tab',
            comment: 'The transfers that finished.',
        }),
        empty: t`No finished transfers`,
        none: t`No transfer has finished yet.`,
        noMatch: (search) => t`Nothing finished has “${search}” in its ID, paths or error.`,
    },
    {
        key: 'failed',
        label: t({
            message: 'Failed',
            context: 'History tab',
            comment: 'The transfers that failed.',
        }),
        empty: t`No failed transfers`,
        none: t`No transfer has failed.`,
        noMatch: (search) => t`Nothing failed has “${search}” in its ID, paths or error.`,
    },
    {
        key: 'stopped',
        label: t({
            message: 'Stopped',
            context: 'History tab',
            comment: 'The transfers that were stopped or interrupted.',
        }),
        empty: t`No stopped transfers`,
        none: t`No transfer was stopped or interrupted.`,
        noMatch: (search) => t`Nothing stopped has “${search}” in its ID, paths or error.`,
    },
]

export const isStatus = (value: unknown): value is Status =>
    STATUSES.some((status) => status.key === value)

/** The state that the core filters the ended list by, for a tab. All and Running don't filter. */
export function endedStateOf(status: Status): EndedState {
    return status === 'all' || status === 'running' ? '' : status
}

export interface Shown {
    status: Status
    search: string
}

const KEY = 'history'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

const session = (): Storage | undefined =>
    typeof sessionStorage === 'undefined' ? undefined : sessionStorage

/** Reads what the window showed last, or All with no search. */
export function readShown(storage = session()): Shown {
    try {
        const kept = JSON.parse(storage?.getItem(KEY) ?? '{}') as Partial<Shown>
        return {
            status: isStatus(kept.status) ? kept.status : 'all',
            search: typeof kept.search === 'string' ? kept.search : '',
        }
    } catch {
        return { status: 'all', search: '' }
    }
}

export function saveShown(shown: Shown, storage = session()) {
    try {
        storage?.setItem(KEY, JSON.stringify(shown))
    } catch {
        // A storage that is full or off only means that the window forgets.
    }
}
