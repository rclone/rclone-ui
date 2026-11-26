// The handoff of History: a transfer that left the running list stays on screen, as it was last
// seen running, until the ended list can show it. The two lists are fetched separately after
// transfers.changed, and either one can answer first.

import type * as Core from '../../../lib/core/types'

type Transfer = Core.Transfers.Transfer

/** A transfer that left the running list, and when the page saw it leave, in ms. */
export interface Leaving {
    item: Transfer
    leftAt: number
}

/**
 * The running list that the handoff last saw, the transfers that left it and are still held, and
 * how many times transfers left. The page asks the ended list again each time transfers leave.
 */
export interface Handoff {
    active: Transfer[]
    leaving: Leaving[]
    exits: number
}

/**
 * Whether a transfer that left is still held. It is held until the ended list has it, or until
 * the ended list answers a question that was sent after the transfer left (`askedAt`). A dropped
 * transfer never comes in the ended list, so only an answer releases it.
 */
export function isHeld(leaving: Leaving, ended: readonly Transfer[], askedAt: number): boolean {
    return !ended.some((transfer) => transfer.id === leaving.item.id) && askedAt <= leaving.leftAt
}

/**
 * Returns the next handoff, or `seen` itself when nothing changed. A new running list adds the
 * transfers that are no longer in it, as left at `now`. The transfers that the ended list
 * released are removed.
 */
export function nextHandoff(
    seen: Handoff,
    active: Transfer[],
    ended: readonly Transfer[],
    askedAt: number,
    now: number
): Handoff {
    const held = (leaving: Leaving) => isHeld(leaving, ended, askedAt)
    if (seen.active !== active) {
        const running = new Set(active.map((transfer) => transfer.id))
        const known = new Set(seen.leaving.map((leaving) => leaving.item.id))
        const left = seen.active
            .filter((transfer) => !running.has(transfer.id) && !known.has(transfer.id))
            .map((item) => ({ item, leftAt: now }))
        return {
            active,
            leaving: [...seen.leaving.filter(held), ...left],
            exits: seen.exits + (left.length > 0 ? 1 : 0),
        }
    }
    if (seen.leaving.every(held)) return seen
    return { ...seen, leaving: seen.leaving.filter(held) }
}
