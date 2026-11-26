import type { Option } from '../../../lib/catalog'
import type { FlagValue } from '../../../types/rclone'

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
