import { Autocomplete, AutocompleteItem, Button, Checkbox, Select, SelectItem } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRightIcon, PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { exe } from '../../lib/api/paths'
import { getFsInfo } from '../../lib/format'
import { backendsQueryOptions, fsInfoQueryOptions, remoteConfigQueryOptions } from '../../lib/hooks'
import { LOCAL_HOST_ID } from '../../lib/hosts'
import { currentHostId } from '../../lib/rclone/client'
import {
    type MapperRule,
    type MapperValue,
    buildMapperValue,
    gatedDestinations,
    parseMapperValue,
    quoteArgv,
} from '../../lib/rclone/metadataMapper'
import type { FlagValue, RcloneFsInfo } from '../../types/rclone'

type RuleKind = MapperRule['kind']

// One row while it is being edited: a kind change keeps whatever was typed, which a discriminated
// union would throw away. `touched` is set when focus leaves the row — a half-written rule is not
// a mistake until then, and marking one while its first field is still being typed is noise.
type Row = { id: number; kind: RuleKind; left: string; right: string; touched: boolean }

const KINDS: Array<{ key: RuleKind; label: string; description: string }> = [
    { key: 'map', label: 'Map', description: 'Rename a field on the way across' },
    { key: 'set', label: 'Set', description: 'Give a field a fixed value' },
    { key: 'drop', label: 'Drop', description: 'Leave a field behind' },
]

const TRAILING_COLON = /:$/

let nextRowId = 0
const newRow = (kind: RuleKind = 'map'): Row => ({
    id: nextRowId++,
    kind,
    left: '',
    right: '',
    touched: false,
})

function toRows(rules: MapperRule[]): Row[] {
    const rows = rules.map((rule) =>
        rule.kind === 'map'
            ? { id: nextRowId++, kind: rule.kind, left: rule.from, right: rule.to, touched: true }
            : rule.kind === 'set'
              ? {
                    id: nextRowId++,
                    kind: rule.kind,
                    left: rule.key,
                    right: rule.value,
                    touched: true,
                }
              : { id: nextRowId++, kind: rule.kind, left: rule.key, right: '', touched: true }
    )
    return rows.length > 0 ? rows : [newRow()]
}

function toRule(row: Row): MapperRule {
    if (row.kind === 'map') return { kind: 'map', from: row.left, to: row.right }
    if (row.kind === 'set') return { kind: 'set', key: row.left, value: row.right }
    return { kind: 'drop', key: row.left }
}

const isEmptyRow = (row: Row) => !row.left && !row.right
const isCompleteRow = (row: Row) => !!row.left && (row.kind === 'drop' || !!row.right)

/** The rules as they are being edited, and whether fields no rule mentions pass through. */
type Draft = { rows: Row[]; keepUnmapped: boolean }

/** The draft a flag reads as; a foreign one has no rules to show until it is replaced. */
const draftOf = (parsed: MapperValue | null): Draft => ({
    rows: toRows(parsed?.rules ?? []),
    keepUnmapped: parsed?.keepUnmapped ?? true,
})

/** The flag value for a draft: its complete rules, or nothing while it has none. */
function valueOf(rows: Row[], keepUnmapped: boolean): string[] | '' {
    const rules = rows.filter(isCompleteRow).map(toRule)
    return rules.length > 0 ? buildMapperValue(exe, rules, keepUnmapped) : ''
}

/**
 * The remote a path lives on. `gdrive:photos/` and `/tmp/x` both answer with their fs;
 * `fsInfoQueryOptions` puts the colon back, so `:local` is exactly right for a local path.
 */
function remoteOf(path: string | undefined) {
    return path ? getFsInfo(path).root.replace(TRAILING_COLON, '') : undefined
}

/** The metadata fields a remote's backend knows, from the same cached `fsinfo` the app already runs. */
function useMetadataKeys(remote: string | undefined) {
    const query = useQuery(fsInfoQueryOptions(remote))
    return useMemo(() => {
        const system = (query.data as RcloneFsInfo | undefined)?.MetadataInfo?.System ?? {}
        return Object.entries(system).map(([key, help]) => ({ key, ...help }))
    }, [query.data])
}

function FieldInput({
    label,
    value,
    onChange,
    keys,
    isInvalid,
}: {
    label: string
    value: string
    onChange: (value: string) => void
    keys: Array<{ key: string; Help?: string; Example?: string; ReadOnly?: boolean }>
    isInvalid: boolean
}) {
    // Filtered here, and passed as `items` rather than `defaultItems`: the backend's fields
    // arrive from `fsinfo` whenever it answers, which is often after this panel has appeared,
    // and an uncontrolled collection keeps whatever it was given at mount — an empty list, forever.
    const shown = useMemo(() => {
        const typed = value.trim().toLowerCase()
        return keys.filter((field) => field.key.toLowerCase().startsWith(typed))
    }, [keys, value])

    return (
        <Autocomplete
            className="flex-1 min-w-0"
            // Wider than the field, which is one of two columns in a row: the list carries each
            // field's own help from the backend, and HeroUI sizes the popover to its trigger.
            classNames={{ popoverContent: 'w-72' }}
            aria-label={label}
            placeholder={label}
            size="sm"
            inputValue={value}
            // Typed text is the value; picking from the list only fills it in. Backends take
            // metadata keys they never declare (`user.*`, `x-amz-meta-*`), so the list suggests.
            onInputChange={onChange}
            onSelectionChange={(key) => key !== null && onChange(String(key))}
            allowsCustomValue={true}
            // A backend that declares no metadata fields, or a key none of them has, must not
            // pop an empty list over the rest of the page.
            allowsEmptyCollection={false}
            menuTrigger="input"
            isInvalid={isInvalid}
            items={shown}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck="false"
        >
            {(item) => (
                <AutocompleteItem
                    key={item.key}
                    textValue={item.key}
                    description={item.Help || item.Example}
                    // rclone's own help, wrapped rather than cut: the caveat that decides whether
                    // a field can be written at all ("Enable with --drive-metadata-owner") is at
                    // the end of the sentence, which is the half a truncation takes.
                    classNames={{ description: 'whitespace-normal' }}
                >
                    {item.key}
                </AutocompleteItem>
            )}
        </Autocomplete>
    )
}

/**
 * The editor of the `metadata_mapper` flag, inline: at the top of a Metadata section while the
 * flag is there, and on the Wizard's metadata step. rclone's flag takes a program, so what this
 * writes is a command line: this app's own binary, its `metadata-map` subcommand, and the rules
 * as arguments (`lib/rclone/metadataMapper.ts`). rclone runs it once per file and directory copied.
 *
 * Edits reach the flag as they are made, complete rules only: a row with a field still empty
 * stays here until it has both. What comes back through `value` is compared with what was last
 * read or written, so a change from elsewhere (a hand edit of the JSON, a template, a preset)
 * replaces the draft, and the editor's own writes coming back leave it alone.
 *
 * `metadata` has to be on beside the flag — verified against rclone 1.75: without it the mapper
 * is never called at all. The chip that adds the flag brings it, and the section's JSON says so
 * when they come apart (`metadataOptionsProblem`).
 */
export default function MetadataMapper({
    value,
    onChange,
    paths,
    remoteOverrides,
}: {
    value: FlagValue
    /** The flag as the rules amount to: an argv array, or an empty string with no rule. */
    onChange: (value: string[] | '') => void
    /** The two ends of the operation, so each side can suggest the fields its backend knows. */
    paths?: { source?: string; destination?: string }
    /** This run's per-remote backend overrides, which beat what the remote is saved with. */
    remoteOverrides?: Record<string, Record<string, FlagValue>>
}) {
    const headingId = useId()
    const parsed = useMemo(() => parseMapperValue(value), [value])
    const [{ rows, keepUnmapped }, setDraft] = useState<Draft>(() => draftOf(parsed))
    // The draft as of the last edit, for the next one to build on: a pick from a field's list
    // changes the text and the selection in one tick, and a blur can land beside an edit.
    const latest = useRef<Draft>({ rows, keepUnmapped })
    const reset = (next: Draft) => {
        latest.current = next
        setDraft(next)
    }
    // The flag as this editor last read or wrote it, by content: the JSON hands the array back
    // as a new object every time it is parsed.
    const known = useRef(JSON.stringify(value))

    // biome-ignore lint/correctness/useExhaustiveDependencies: `reset` is this render's setter; the flag is the input
    useEffect(() => {
        const key = JSON.stringify(value)
        if (key === known.current) return
        known.current = key
        reset(draftOf(parseMapperValue(value)))
    }, [value])

    // Without a path to run there is no mapper to write: an argv starting with "" would reach
    // rclone and fail every transfer with something far less obvious than this sentence.
    const noProgram = exe === ''

    const commit = (next: Draft) => {
        reset(next)
        if (noProgram) return
        const flag = valueOf(next.rows, next.keepUnmapped)
        const key = JSON.stringify(flag)
        if (key === known.current) return
        known.current = key
        onChange(flag)
    }
    const update = (id: number, patch: Partial<Row>) =>
        commit({
            ...latest.current,
            rows: latest.current.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
        })

    const sourceRemote = remoteOf(paths?.source)
    const destinationRemote = remoteOf(paths?.destination)
    const sourceKeys = useMetadataKeys(sourceRemote)
    const destinationKeys = useMetadataKeys(destinationRemote)
    // A read-only field can be read from the source but never written to the destination.
    const writableKeys = useMemo(
        () => destinationKeys.filter((field) => !field.ReadOnly),
        [destinationKeys]
    )

    // What the destination remote is configured with, and what its backend's options mean: a
    // field like `owner` is only written when the backend's own `metadata_owner` says so.
    const destinationConfig = useQuery({
        ...remoteConfigQueryOptions(destinationRemote),
        enabled: !!destinationRemote,
    })
    const backends = useQuery(backendsQueryOptions())

    // A flag pointing at someone else's program is their work: it is shown, not silently reshaped.
    const foreign = parsed === null
    // A rule is only pointed at once its row is left.
    const showsProblem = rows.some((row) => row.touched && !isEmptyRow(row) && !isCompleteRow(row))
    const rules = rows.filter(isCompleteRow).map(toRule)
    const commandLine = valueOf(rows, keepUnmapped)

    // A wrapping backend (crypt over drive, say) reports its own type here, so its options are
    // the ones asked about; the wrapped remote's gate is missed rather than guessed at.
    const config = destinationConfig.data as Record<string, unknown> | undefined
    const backendOptions = (
        backends.data as
            | Array<{ Name: string; Options?: Array<{ Name: string; DefaultStr?: string }> }>
            | undefined
    )?.find((backend) => backend.Name === config?.type)?.Options
    const gated = gatedDestinations({
        fields: rules.map((rule) => (rule.kind === 'map' ? rule.to : rule.key)).filter(Boolean),
        backendOptions,
        config,
        overrides: destinationRemote ? remoteOverrides?.[destinationRemote] : undefined,
    })
    const onOtherHost = currentHostId() !== LOCAL_HOST_ID
    // Only where there are paths to pick: a template has none.
    const noPaths = !!paths && !paths.source && !paths.destination

    return (
        <section
            aria-labelledby={headingId}
            className="flex flex-col gap-4 p-4 border rounded-xl border-divider bg-default-50 dark:border-neutral-800 dark:bg-white/[0.03]"
        >
            <h3 id={headingId} className="text-small font-medium">
                Metadata mapping
            </h3>

            {foreign ? (
                <div className="flex flex-col gap-3 p-3 rounded-medium bg-warning-50 text-warning-700 dark:bg-warning-500/10 dark:text-warning-400">
                    <p className="text-small">
                        This flag already runs a program of your own. Replacing it with a mapping
                        here will overwrite it.
                    </p>
                    <pre className="p-2 overflow-x-auto text-tiny rounded-small bg-content2 text-foreground-600">
                        {quoteArgv(Array.isArray(value) ? value : [String(value)])}
                    </pre>
                    <Button
                        size="sm"
                        color="warning"
                        variant="flat"
                        className="self-start"
                        // Written at once, as every other edit here is: the flag is theirs no
                        // more, and the rules take its place.
                        onPress={() => {
                            known.current = JSON.stringify('')
                            reset(draftOf(null))
                            onChange('')
                        }}
                    >
                        Replace it
                    </Button>
                </div>
            ) : (
                <>
                    <div className="flex flex-col gap-2">
                        {rows.map((row) => {
                            const invalid = row.touched && !isEmptyRow(row) && !isCompleteRow(row)
                            return (
                                <div
                                    key={row.id}
                                    className="flex items-start gap-2"
                                    onBlur={(event) => {
                                        // Moving between this row's own fields is still writing
                                        // it; leaving the row is finishing it.
                                        if (!event.currentTarget.contains(event.relatedTarget)) {
                                            update(row.id, { touched: true })
                                        }
                                    }}
                                >
                                    <Select
                                        aria-label="Rule"
                                        size="sm"
                                        className="w-24 shrink-0"
                                        // The trigger only has to fit "Map"; the list has to fit
                                        // what each kind does, and HeroUI would otherwise size
                                        // the popover to the trigger.
                                        classNames={{ popoverContent: 'w-64' }}
                                        selectedKeys={[row.kind]}
                                        disallowEmptySelection={true}
                                        onSelectionChange={(keys) =>
                                            update(row.id, { kind: [...keys][0] as RuleKind })
                                        }
                                    >
                                        {KINDS.map((kind) => (
                                            <SelectItem
                                                key={kind.key}
                                                description={kind.description}
                                            >
                                                {kind.label}
                                            </SelectItem>
                                        ))}
                                    </Select>
                                    <FieldInput
                                        label={row.kind === 'map' ? 'From' : 'Field'}
                                        value={row.left}
                                        onChange={(left) => update(row.id, { left })}
                                        keys={row.kind === 'set' ? writableKeys : sourceKeys}
                                        isInvalid={invalid && !row.left}
                                    />
                                    <div className="flex items-center justify-center h-8 w-3 shrink-0 text-foreground-400">
                                        {row.kind === 'map' ? (
                                            <ArrowRightIcon className="size-4" />
                                        ) : row.kind === 'set' ? (
                                            <span>=</span>
                                        ) : null}
                                    </div>
                                    {row.kind === 'drop' ? (
                                        <div className="flex-1 min-w-0" />
                                    ) : (
                                        <FieldInput
                                            label={row.kind === 'set' ? 'Value' : 'To'}
                                            value={row.right}
                                            onChange={(right) => update(row.id, { right })}
                                            keys={row.kind === 'map' ? writableKeys : []}
                                            isInvalid={invalid && !row.right}
                                        />
                                    )}
                                    <Button
                                        isIconOnly={true}
                                        size="sm"
                                        variant="light"
                                        aria-label="Remove this rule"
                                        onPress={() => {
                                            const left = latest.current.rows.filter(
                                                (candidate) => candidate.id !== row.id
                                            )
                                            commit({
                                                ...latest.current,
                                                rows: left.length > 0 ? left : [newRow()],
                                            })
                                        }}
                                    >
                                        <XIcon className="size-4" />
                                    </Button>
                                </div>
                            )
                        })}
                        <Button
                            size="sm"
                            variant="flat"
                            className="self-start"
                            startContent={<PlusIcon className="size-4" />}
                            onPress={() =>
                                reset({
                                    ...latest.current,
                                    rows: [...latest.current.rows, newRow()],
                                })
                            }
                        >
                            Add rule
                        </Button>
                        {showsProblem && (
                            <p className="text-tiny text-danger">
                                A rule is left out until both of its fields are filled in.
                            </p>
                        )}
                    </div>

                    <Checkbox
                        size="sm"
                        isSelected={keepUnmapped}
                        onValueChange={(keep) => commit({ ...latest.current, keepUnmapped: keep })}
                    >
                        Keep fields that no rule mentions
                    </Checkbox>

                    {gated.length > 0 && (
                        <div className="flex gap-2 text-tiny text-warning-600 dark:text-warning-400">
                            <TriangleAlertIcon className="size-4 shrink-0" />
                            <div className="flex flex-col gap-1">
                                <span>
                                    {destinationRemote} will not write{' '}
                                    {gated.length === 1 ? 'this field' : 'these fields'} as it is
                                    set up now:
                                </span>
                                {gated.map((field) => (
                                    <span key={field.field}>
                                        <span className="font-mono">{field.field}</span> needs{' '}
                                        <span className="font-mono">{field.option}</span> to include{' '}
                                        <span className="font-mono">write</span>; it is{' '}
                                        <span className="font-mono">{field.value}</span>.
                                    </span>
                                ))}
                                <span>
                                    {gated.length === 1 ? 'Change it' : 'Change them'} on the remote
                                    {remoteOverrides
                                        ? ', or for this run alone in the Remotes section of this page'
                                        : ''}
                                    .
                                </span>
                            </div>
                        </div>
                    )}

                    {noProgram && (
                        <p className="flex gap-2 text-tiny text-danger">
                            <TriangleAlertIcon className="size-4 shrink-0" />
                            <span>
                                This server cannot tell where its own program lives, so there is
                                nothing to point the flag at.
                            </span>
                        </p>
                    )}

                    {onOtherHost && (
                        <p className="flex gap-2 text-tiny text-warning-600 dark:text-warning-400">
                            <TriangleAlertIcon className="size-4 shrink-0" />
                            <span>
                                This host runs rclone on another machine, where this program may not
                                exist. The path below has to be one that machine can run.
                            </span>
                        </p>
                    )}

                    {noPaths && (
                        <p className="text-tiny text-foreground-500">
                            Pick the operation's paths first and each side will suggest the fields
                            its backend knows.
                        </p>
                    )}

                    {commandLine !== '' && (
                        <div className="flex flex-col gap-1">
                            <p className="text-tiny text-foreground-500">
                                rclone runs this once per file and directory:
                            </p>
                            <pre className="p-2 overflow-x-auto whitespace-pre-wrap break-all text-tiny rounded-small bg-content2 text-foreground-600">
                                {quoteArgv(commandLine)}
                            </pre>
                        </div>
                    )}
                </>
            )}
        </section>
    )
}
