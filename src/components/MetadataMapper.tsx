import { Autocomplete, AutocompleteItem, Button, Checkbox, Select, SelectItem } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowRightSmall as ArrowRightSmallIcon,
    ExclamationTriangle as ExclamationTriangleIcon,
    Plus as PlusIcon,
    Xmark as XmarkIcon,
} from '@zappicon/react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useBackendOptions, useBackends } from '../../lib/catalog'
import { parsePath } from '../../lib/paths'
import {
    buildMapperValue,
    gatedDestinations,
    type MapperRule,
    type MapperValue,
    parseMapperValue,
    quoteArgv,
} from '../../lib/rclone/metadataMapper'
import { useRemoteConfig, useRemotes } from '../../lib/remotes'
import type { FlagValue } from '../../types/rclone'

type RuleKind = MapperRule['kind']

type Row = { id: number; kind: RuleKind; left: string; right: string; touched: boolean }

const KINDS: Array<{ key: RuleKind; label: string; description: string }> = [
    {
        key: 'map',
        label: t({ message: 'Map', comment: 'A kind of metadata rule, which renames a field.' }),
        description: t`Rename a field on the way across`,
    },
    {
        key: 'set',
        label: t({ message: 'Set', comment: 'A kind of metadata rule, which sets a field.' }),
        description: t`Give a field a fixed value`,
    },
    {
        key: 'drop',
        label: t({
            message: 'Drop',
            comment: 'A kind of metadata rule, which leaves a field out.',
        }),
        description: t`Leave a field behind`,
    },
]

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

type Draft = { rows: Row[]; keepUnmapped: boolean }

const draftOf = (parsed: MapperValue | null): Draft => ({
    rows: toRows(parsed?.rules ?? []),
    keepUnmapped: parsed?.keepUnmapped ?? true,
})

function valueOf(rows: Row[], keepUnmapped: boolean): string[] | '' {
    const rules = rows.filter(isCompleteRow).map(toRule)
    return rules.length > 0 ? buildMapperValue(rules, keepUnmapped) : ''
}

function remoteNameOf(path: string | undefined) {
    if (!path) return undefined
    const parsed = parsePath(path)
    return parsed.kind === 'remote' ? parsed.name : ':local'
}

function remoteOf(path: string | undefined) {
    const parsed = path ? parsePath(path) : undefined
    return parsed?.kind === 'remote' && !parsed.name.startsWith(':') && !parsed.params
        ? parsed.name
        : undefined
}

function useMetadataKeys(name: string | undefined) {
    const { remotes } = useRemotes()
    const backends = useBackends()
    return useMemo(() => {
        if (!name) return []
        const onTheFly = name.startsWith(':')
        const configured = onTheFly ? undefined : remotes.find((r) => r.name === name)
        let info = configured?.fsinfo?.metadataInfo
        if (!configured) {
            const type = onTheFly ? name.slice(1) : 'local'
            info = backends?.find((b) => b.name === type)?.metadataInfo
        }
        return Object.entries(info?.System ?? {}).flatMap(([key, help]) =>
            help ? [{ key, ...help }] : []
        )
    }, [name, remotes, backends])
}

const SHOWN_PROGRAM = 'rcui'

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
    const shown = useMemo(() => {
        const typed = value.trim().toLowerCase()
        return keys.filter((field) => field.key.toLowerCase().startsWith(typed))
    }, [keys, value])

    return (
        <Autocomplete
            className="flex-1 min-w-0"
            classNames={{ popoverContent: 'w-72' }}
            aria-label={label}
            placeholder={label}
            size="sm"
            inputValue={value}
            onInputChange={onChange}
            onSelectionChange={(key) => key !== null && onChange(String(key))}
            allowsCustomValue={true}
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
                    classNames={{ description: 'whitespace-normal' }}
                >
                    {item.key}
                </AutocompleteItem>
            )}
        </Autocomplete>
    )
}

function gatedIntro(remote: string, count: number): string {
    return plural(count, {
        one: `${remote} will not write this field as it is set up now:`,
        other: `${remote} will not write these fields as it is set up now:`,
    })
}

function GatedLine({ field, option, value }: { field: string; option: string; value: string }) {
    return (
        <span>
            <Trans>
                <span className="font-mono">{field}</span> needs{' '}
                <span className="font-mono">{option}</span> to include{' '}
                <span className="font-mono">write</span>; it is{' '}
                <span className="font-mono">{value}</span>.
            </Trans>
        </span>
    )
}

function gatedFix(count: number, thisRun: boolean): string {
    return thisRun
        ? plural(count, {
              one: 'Change it on the remote, or for this run alone in the Remotes section of this page.',
              other: 'Change them on the remote, or for this run alone in the Remotes section of this page.',
          })
        : plural(count, {
              one: 'Change it on the remote.',
              other: 'Change them on the remote.',
          })
}

export default function MetadataMapper({
    value,
    onChange,
    paths,
    remoteOverrides,
}: {
    value: FlagValue
    onChange: (value: string[] | '') => void
    paths?: { source?: string; destination?: string }
    remoteOverrides?: Record<string, Record<string, FlagValue>>
}) {
    const headingId = useId()
    const parsed = useMemo(() => parseMapperValue(value), [value])
    const [{ rows, keepUnmapped }, setDraft] = useState<Draft>(() => draftOf(parsed))
    const latest = useRef<Draft>({ rows, keepUnmapped })
    const reset = (next: Draft) => {
        latest.current = next
        setDraft(next)
    }
    const known = useRef(JSON.stringify(value))

    // biome-ignore lint/correctness/useExhaustiveDependencies: `reset` is this render's setter; the flag is the input
    useEffect(() => {
        const key = JSON.stringify(value)
        if (key === known.current) return
        known.current = key
        reset(draftOf(parseMapperValue(value)))
    }, [value])

    const commit = (next: Draft) => {
        reset(next)
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

    const destinationRemote = remoteOf(paths?.destination)
    const sourceKeys = useMetadataKeys(remoteNameOf(paths?.source))
    const destinationKeys = useMetadataKeys(remoteNameOf(paths?.destination))
    const writableKeys = useMemo(
        () => destinationKeys.filter((field) => !field.ReadOnly),
        [destinationKeys]
    )

    const { data: config } = useRemoteConfig(destinationRemote)

    const foreign = parsed === null
    const showsProblem = rows.some((row) => row.touched && !isEmptyRow(row) && !isCompleteRow(row))
    const rules = rows.filter(isCompleteRow).map(toRule)
    const commandLine = valueOf(rows, keepUnmapped)

    const backendOptions = useBackendOptions(config?.type, config?.provider)
    const gated = gatedDestinations({
        fields: rules.map((rule) => (rule.kind === 'map' ? rule.to : rule.key)).filter(Boolean),
        backendOptions,
        config,
        overrides: destinationRemote ? remoteOverrides?.[destinationRemote] : undefined,
    })
    const noPaths = !!paths && !paths.source && !paths.destination

    return (
        <section
            aria-labelledby={headingId}
            className="flex flex-col gap-4 p-4 border rounded-xl border-divider bg-default-50 dark:border-neutral-800 dark:bg-white/3"
        >
            <h3 id={headingId} className="text-small font-medium">
                <Trans>Metadata mapping</Trans>
            </h3>

            {foreign ? (
                <div className="flex flex-col gap-3 p-3 rounded-medium bg-warning-50 text-warning-700 dark:bg-warning-500/10 dark:text-warning-400">
                    <p className="text-small">
                        <Trans>
                            This flag already runs a program of your own. Replacing it with a
                            mapping here will overwrite it.
                        </Trans>
                    </p>
                    <pre className="p-2 overflow-x-auto text-tiny rounded-small bg-content2 text-foreground-600">
                        {quoteArgv(Array.isArray(value) ? value : [String(value)])}
                    </pre>
                    <Button
                        size="sm"
                        color="warning"
                        variant="flat"
                        className="self-start"
                        onPress={() => {
                            known.current = JSON.stringify('')
                            reset(draftOf(null))
                            onChange('')
                        }}
                    >
                        <Trans>Replace it</Trans>
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
                                        if (!event.currentTarget.contains(event.relatedTarget)) {
                                            update(row.id, { touched: true })
                                        }
                                    }}
                                >
                                    <Select
                                        aria-label={t({
                                            message: 'Rule',
                                            comment:
                                                'The kind of a metadata rule: map, set or drop.',
                                        })}
                                        size="sm"
                                        className="w-24 shrink-0"
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
                                        label={
                                            row.kind === 'map'
                                                ? t({
                                                      message: 'From',
                                                      comment:
                                                          'The field that a metadata rule renames.',
                                                  })
                                                : t({
                                                      message: 'Field',
                                                      comment:
                                                          'The metadata field that a rule sets or drops.',
                                                  })
                                        }
                                        value={row.left}
                                        onChange={(left) => update(row.id, { left })}
                                        keys={row.kind === 'set' ? writableKeys : sourceKeys}
                                        isInvalid={invalid && !row.left}
                                    />
                                    <div className="flex items-center justify-center h-8 w-3 shrink-0 text-foreground-400">
                                        {row.kind === 'map' ? (
                                            <ArrowRightSmallIcon className="size-4" />
                                        ) : row.kind === 'set' ? (
                                            <span>=</span>
                                        ) : null}
                                    </div>
                                    {row.kind === 'drop' ? (
                                        <div className="flex-1 min-w-0" />
                                    ) : (
                                        <FieldInput
                                            label={
                                                row.kind === 'set'
                                                    ? t({
                                                          message: 'Value',
                                                          comment:
                                                              'The value that a metadata rule sets.',
                                                      })
                                                    : t({
                                                          message: 'To',
                                                          comment:
                                                              'The new name of a renamed metadata field.',
                                                      })
                                            }
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
                                        aria-label={t`Remove this rule`}
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
                                        <XmarkIcon className="size-4" />
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
                            <Trans>Add rule</Trans>
                        </Button>
                        {showsProblem && (
                            <p className="text-tiny text-danger">
                                <Trans>
                                    A rule is left out until both of its fields are filled in.
                                </Trans>
                            </p>
                        )}
                    </div>

                    <Checkbox
                        size="sm"
                        isSelected={keepUnmapped}
                        onValueChange={(keep) => commit({ ...latest.current, keepUnmapped: keep })}
                    >
                        <Trans>Keep fields that no rule mentions</Trans>
                    </Checkbox>

                    {gated.length > 0 && (
                        <div className="flex gap-2 text-tiny text-warning-600 dark:text-warning-400">
                            <ExclamationTriangleIcon className="size-4 shrink-0" />
                            <div className="flex flex-col gap-1">
                                <span>{gatedIntro(destinationRemote ?? '', gated.length)}</span>
                                {gated.map((field) => (
                                    <GatedLine key={field.field} {...field} />
                                ))}
                                <span>{gatedFix(gated.length, !!remoteOverrides)}</span>
                            </div>
                        </div>
                    )}

                    {noPaths && (
                        <p className="text-tiny text-foreground-500">
                            <Trans>
                                Pick the paths first to see the fields that each side supports.
                            </Trans>
                        </p>
                    )}

                    {commandLine !== '' && (
                        <div className="flex flex-col gap-1">
                            <p className="text-tiny text-foreground-500">
                                <Trans>Rclone runs this once per file and folder:</Trans>
                            </p>
                            <pre className="p-2 overflow-x-auto whitespace-pre-wrap break-all text-tiny rounded-small bg-content2 text-foreground-600">
                                {quoteArgv([SHOWN_PROGRAM, ...commandLine])}
                            </pre>
                        </div>
                    )}
                </>
            )}
        </section>
    )
}
