import type { Option } from '../../../lib/catalog'
import type { FlagValue } from '../../../types/rclone'

/**
 * Returns the Serve options to keep when the user switches to another serve type: the ones with a
 * value that the new type also has, matched by name. The others belong only to the old type, and
 * the new type would reject them.
 */
export function carryOptions(
    options: Record<string, FlagValue>,
    available: readonly Pick<Option, 'name'>[]
): Record<string, FlagValue> {
    const names = new Set(available.map((option) => option.name))
    return Object.fromEntries(
        Object.entries(options).filter(
            ([name, value]) =>
                names.has(name) && value !== null && value !== undefined && value !== ''
        )
    )
}
