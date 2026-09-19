import type { FlagValue } from '../../types/rclone'

/**
 * The codec between the metadata mapping drawer and rclone's `--metadata-mapper` flag.
 *
 * rclone's flag wants a program, not a rule list: it runs one per file and directory copied and
 * talks JSON to it over a pipe. The program is this app's own binary (`paths.exe`) with the
 * `metadata-map` subcommand, whose arguments are the rules — see
 * `src/metadata_mapper.rs`, which is the other half of this grammar.
 *
 * The value is an argv ARRAY, never a string. rclone splits a string on spaces, and the
 * binary's path may hold one; `toConfigParam` sends the array straight through to
 * `_config.MetadataMapper`, which is what rclone's SpaceSepList wants.
 */

export const MAPPER_SUBCOMMAND = 'metadata-map'

export type MapperRule =
    | { kind: 'map'; from: string; to: string }
    | { kind: 'set'; key: string; value: string }
    | { kind: 'drop'; key: string }

export interface MapperValue {
    rules: MapperRule[]
    /** Whether fields no rule mentions are passed through (rclone's default here, and ours). */
    keepUnmapped: boolean
}

const WHITESPACE = /\s+/

/** Whatever the JSON holds, as argv. A hand-typed string splits the way rclone would split it. */
function toArgv(value: FlagValue): string[] {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') return value.trim().split(WHITESPACE).filter(Boolean)
    return []
}

/** `key=value` split on the FIRST `=`, so a value may contain more of them. */
function splitPair(argument: string): [string, string] | null {
    const index = argument.indexOf('=')
    if (index <= 0) return null
    return [argument.slice(0, index), argument.slice(index + 1)]
}

/**
 * The rules behind a flag value, or `null` when it runs someone else's program — or ours with
 * arguments this editor did not write. Both are somebody's work: the drawer says so and asks
 * before replacing it. An empty flag is nobody's, so it comes back as an empty mapping.
 *
 * The program the value names is not returned: a saved value is always rewritten with the binary
 * running right now (`buildMapperValue`), so there is nothing to carry over from the old one.
 */
export function parseMapperValue(value: FlagValue): MapperValue | null {
    const argv = toArgv(value)
    if (argv.length === 0) return { rules: [], keepUnmapped: true }
    if (argv[1] !== MAPPER_SUBCOMMAND) return null

    const rules: MapperRule[] = []
    let keepUnmapped = true
    for (let index = 2; index < argv.length; index += 1) {
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

/** The flag value for a set of rules, always pointing at the binary running right now. */
export function buildMapperValue(
    exe: string,
    rules: MapperRule[],
    keepUnmapped: boolean
): string[] {
    const argv = [exe, MAPPER_SUBCOMMAND]
    if (!keepUnmapped) argv.push('--only-mapped')
    for (const rule of rules) {
        if (rule.kind === 'map') argv.push('--map', `${rule.from}=${rule.to}`)
        else if (rule.kind === 'set') argv.push('--set', `${rule.key}=${rule.value}`)
        else argv.push('--drop', rule.key)
    }
    return argv
}

/** An argv as one line, for showing the user exactly what rclone will run. */
export function quoteArgv(argv: string[]): string {
    return argv.map((part) => (WHITESPACE.test(part) ? `"${part}"` : part)).join(' ')
}

/** Whether the flag names a program to run at all. */
export function hasMapper(value: FlagValue | undefined): boolean {
    return toArgv(value ?? '').length > 0
}

/**
 * Why a set of metadata options will not do what it says, or nothing.
 *
 * rclone only calls the mapper when `--metadata` is on — checked against 1.75, and undocumented:
 * without it the program is never spawned and every rule silently does nothing. Tapping the
 * `metadata_mapper` chip switches `metadata` on for exactly this reason; this is what catches the
 * pair coming apart afterwards, by hand or from an imported command line.
 */
export function metadataOptionsProblem(
    options: Record<string, FlagValue> | undefined
): string | undefined {
    if (!options || !hasMapper(options.metadata_mapper)) return undefined
    if (options.metadata === true) return undefined
    return 'Set "metadata": true to use the metadata mapper'
}

export interface GatedField {
    /** The metadata field a rule writes. */
    field: string
    /** The backend option that decides whether it is written, e.g. `metadata_owner`. */
    option: string
    /** What that option is set to right now. */
    value: string
}

/**
 * The fields a mapping writes that the destination remote will quietly drop.
 *
 * Some backends put their people-shaped metadata behind an option of their own: Google Drive
 * writes `owner` only when `metadata_owner` says `write` (it defaults to reading it), and
 * `permissions` only when `metadata_permissions` does (it defaults to off), and OneDrive is the
 * same for `permissions`. The option is always named after the field, so no list of them is kept
 * here — the backend's own option set is asked instead, and a backend without such an option
 * gates nothing.
 *
 * Precedence is the same as rclone's: this run's per-remote override, then what the remote is
 * saved with, then the backend's default.
 */
export function gatedDestinations({
    fields,
    backendOptions,
    config,
    overrides,
}: {
    fields: string[]
    backendOptions: Array<{ Name: string; DefaultStr?: string }> | undefined
    config?: Record<string, unknown>
    overrides?: Record<string, unknown>
}): GatedField[] {
    const gated: GatedField[] = []
    for (const field of new Set(fields)) {
        const option = `metadata_${field}`
        const definition = backendOptions?.find((candidate) => candidate.Name === option)
        if (!definition) continue
        const raw = overrides?.[option] ?? config?.[option] ?? definition.DefaultStr ?? ''
        const value = String(raw)
        // rclone reads these as a comma-separated set (`read,write`, `write,failok`, `off`).
        if (value.split(',').some((part) => part.trim().toLowerCase() === 'write')) continue
        gated.push({ field, option, value: value || 'off' })
    }
    return gated
}
