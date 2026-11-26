import type { FlagValue } from '../../types/rclone'

const MAPPER_SUBCOMMAND = 'metadata-map'

export type MapperRule =
    | { kind: 'map'; from: string; to: string }
    | { kind: 'set'; key: string; value: string }
    | { kind: 'drop'; key: string }

export interface MapperValue {
    rules: MapperRule[]
    keepUnmapped: boolean
}

function toArgv(value: FlagValue): string[] {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') return value.trim() ? [value] : []
    return []
}

function splitPair(argument: string): [string, string] | null {
    const index = argument.indexOf('=')
    if (index <= 0) return null
    return [argument.slice(0, index), argument.slice(index + 1)]
}

export function parseMapperValue(value: FlagValue): MapperValue | null {
    const argv = toArgv(value)
    if (argv.length === 0) return { rules: [], keepUnmapped: true }
    if (argv[0] !== MAPPER_SUBCOMMAND) return null

    const rules: MapperRule[] = []
    let keepUnmapped = true
    for (let index = 1; index < argv.length; index += 1) {
        const flag = argv[index]
        if (flag === '--only-mapped') {
            keepUnmapped = false
            continue
        }
        const argument = argv[index + 1]
        if (argument === undefined) return null
        index += 1
        if (flag === '--drop') {
            rules.push({ kind: 'drop', key: argument })
            continue
        }
        const pair = splitPair(argument)
        if (!pair) return null
        if (flag === '--map') rules.push({ kind: 'map', from: pair[0], to: pair[1] })
        else if (flag === '--set') rules.push({ kind: 'set', key: pair[0], value: pair[1] })
        else return null
    }
    return { rules, keepUnmapped }
}

export function buildMapperValue(rules: MapperRule[], keepUnmapped: boolean): string[] {
    const argv = [MAPPER_SUBCOMMAND]
    if (!keepUnmapped) argv.push('--only-mapped')
    for (const rule of rules) {
        if (rule.kind === 'map') argv.push('--map', `${rule.from}=${rule.to}`)
        else if (rule.kind === 'set') argv.push('--set', `${rule.key}=${rule.value}`)
        else argv.push('--drop', rule.key)
    }
    return argv
}

export function quoteArgv(argv: string[]): string {
    return argv.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')
}

export interface GatedField {
    field: string
    option: string
    value: string
}

/**
 * Some backends only write metadata about people when one of their own options allows it.
 * Google Drive writes `owner` only when `metadata_owner` includes `write` (the default is
 * `read`), and `permissions` only when `metadata_permissions` does (the default is off). OneDrive
 * does the same for `permissions`.
 */
export function gatedDestinations({
    fields,
    backendOptions,
    config,
    overrides,
}: {
    fields: string[]
    backendOptions: Array<{ name: string; defaultText: string }> | undefined
    config?: Record<string, unknown>
    overrides?: Record<string, unknown>
}): GatedField[] {
    const gated: GatedField[] = []
    for (const field of new Set(fields)) {
        const option = `metadata_${field}`
        const definition = backendOptions?.find((candidate) => candidate.name === option)
        if (!definition) continue
        const raw = overrides?.[option] ?? config?.[option] ?? definition.defaultText
        const value = String(raw)
        if (value.split(',').some((part) => part.trim().toLowerCase() === 'write')) continue
        gated.push({ field, option, value: value || 'off' })
    }
    return gated
}
