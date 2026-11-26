import type * as Core from '../../../lib/core/types'

type Transfer = Core.Transfers.Transfer

export interface Leaving {
    item: Transfer
    leftAt: number
}

export interface Handoff {
    active: Transfer[]
    leaving: Leaving[]
    exits: number
}

export function isHeld(leaving: Leaving, ended: readonly Transfer[], askedAt: number): boolean {
    return !ended.some((transfer) => transfer.id === leaving.item.id) && askedAt <= leaving.leftAt
}

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
