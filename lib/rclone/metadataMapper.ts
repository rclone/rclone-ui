import type { FlagValue } from '../../types/rclone'

/**
 * Converts between the metadata mapping panel and rclone's `--metadata-mapper` flag.
 *
 * The flag takes a program, not a list of rules. rclone runs the program once for each file and
 * directory it copies, and talks JSON to it over a pipe. The program is this app's own
 * `metadata-map` subcommand, and its arguments are the rules. `core/metadatamap` parses the same
 * arguments on the other side.
 *
 * The value is an argv ARRAY, never a string, and it contains no path:
 * `["metadata-map", …rules]`. The core puts the running executable in front whenever it starts a
 * transfer or mount, so a template saved before the binary moved still runs the current one.
 */

const MAPPER_SUBCOMMAND = 'metadata-map'

export type MapperRule =
    | { kind: 'map'; from: string; to: string }
    | { kind: 'set'; key: string; value: string }
    | { kind: 'drop'; key: string }

export interface MapperValue {
    rules: MapperRule[]
    /** Whether fields that no rule mentions are passed through (the default in rclone and here). */
    keepUnmapped: boolean
}

/**
 * Converts whatever the JSON holds to argv. The core stores the app's own mapper as a list, so a
 * typed string is someone's own command line. It stays whole, and the panel leaves it alone.
 */
function toArgv(value: FlagValue): string[] {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') return value.trim() ? [value] : []
    return []
}

/** Splits `key=value` on the FIRST `=`, so the value may contain more of them. */
function splitPair(argument: string): [string, string] | null {
    const index = argument.indexOf('=')
    if (index <= 0) return null
    return [argument.slice(0, index), argument.slice(index + 1)]
}

/**
 * Returns the rules behind a flag value. Returns `null` when the value runs someone else's
 * program, or ours with arguments that this editor didn't write. In both cases someone made it by
 * hand, so the panel says so and asks before replacing it. An empty flag belongs to nobody, so it
 * comes back as an empty mapping.
 */
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

/** Builds the flag value for a set of rules, without a path. The core adds the executable. */
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

/** Joins an argv into one line, to show the user exactly what rclone will run. */
export function quoteArgv(argv: string[]): string {
    return argv.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')
}

export interface GatedField {
    /** The metadata field a rule writes. */
    field: string
    /** The backend option that decides whether it is written, e.g. `metadata_owner`. */
    option: string
    /** The option's current value. */
    value: string
}

/**
 * Returns the fields that a mapping writes but the destination remote will silently drop.
 *
 * Some backends only write metadata about people when one of their own options allows it.
 * Google Drive writes `owner` only when `metadata_owner` includes `write` (the default is
 * `read`), and `permissions` only when `metadata_permissions` does (the default is off). OneDrive
 * does the same for `permissions`. The option is always named after the field, so no list of
 * them is kept here. The backend's own options are checked instead, and a backend without such an
 * option drops nothing.
 *
 * The order of precedence matches rclone's: this run's per-remote override, then the remote's
 * saved config, then the backend's default.
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
        // rclone reads these as a comma-separated set (`read,write`, `write,failok`, `off`).
        if (value.split(',').some((part) => part.trim().toLowerCase() === 'write')) continue
        gated.push({ field, option, value: value || 'off' })
    }
    return gated
}
