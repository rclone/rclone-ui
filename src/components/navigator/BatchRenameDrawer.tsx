import { Button, Chip, cn, Input, Radio, RadioGroup, ScrollShadow, Switch } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowRightSmall as ArrowRightSmallIcon,
    ExclamationCircle as ExclamationCircleIcon,
    Pen as PenIcon,
} from '@zappicon/react'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { formatErrorMessage } from '../../../lib/errors'
import { formatNumber } from '../../../lib/format'
import { baseName } from '../../../lib/paths'
import { openHistory, useRetryable } from '../../../lib/transfers'
import ContentDrawer from '../ContentDrawer'
import { toneButton } from '../look/buttons'
import { SURFACE } from '../look/Panel'
import FileIcon from './FileIcon'
import { batchRename, ELSEWHERE, onTransferEnd } from './fsActions'
import { renamesDone } from './renames'
import type { Entry, SelectItem } from './types'

type CaseMode = 'none' | 'lower' | 'upper' | 'title'

type RenameForm = {
    find: string
    replace: string
    regex: boolean
    caseInsensitive: boolean
    caseMode: CaseMode
    prefix: string
    suffix: string
    numberEnabled: boolean
    numberStart: number
    numberPadding: number
    numberSeparator: string
    includeExtension: boolean
}

const INITIAL_FORM: RenameForm = {
    find: '',
    replace: '',
    regex: false,
    caseInsensitive: false,
    caseMode: 'none',
    prefix: '',
    suffix: '',
    numberEnabled: false,
    numberStart: 1,
    numberPadding: 0,
    numberSeparator: '',
    includeExtension: false,
}

const RE_REGEXP_META = /[.*+?^${}()|[\]\\]/g
const RE_WORD = /\w\S*/g

const APPLY_CASE: Record<CaseMode, (value: string) => string> = {
    none: (value) => value,
    lower: (value) => value.toLowerCase(),
    upper: (value) => value.toUpperCase(),
    title: (value) =>
        value.replace(
            RE_WORD,
            (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        ),
}

// Compiles the find pattern once per plan. Returns `error` when the user's regex doesn't parse.
function compileFind(form: RenameForm): { find?: RegExp; error?: string } {
    if (!form.find) return {}
    try {
        const source = form.regex ? form.find : form.find.replace(RE_REGEXP_META, '\\$&')
        return { find: new RegExp(source, form.caseInsensitive ? 'gi' : 'g') }
    } catch {
        return { error: t`Invalid regular expression` }
    }
}

// Builds the new name as prefix + (find/replace, then case) + suffix + number, and adds the
// extension back at the end.
function computeNewName(
    oldName: string,
    isDir: boolean,
    index: number,
    form: RenameForm,
    find?: RegExp
): string {
    // Folders never have an extension. Files are split on the last dot unless the user chose to
    // include the extension. `dot > 0` keeps dotfiles (".env") whole.
    const dot = isDir || form.includeExtension ? -1 : oldName.lastIndexOf('.')
    const ext = dot > 0 ? oldName.slice(dot) : ''
    let base = dot > 0 ? oldName.slice(0, dot) : oldName

    if (find) base = base.replace(find, form.replace)
    base = APPLY_CASE[form.caseMode](base)

    const number = form.numberEnabled
        ? `${form.numberSeparator}${String(form.numberStart + index).padStart(form.numberPadding, '0')}`
        : ''
    return `${form.prefix}${base}${form.suffix}${number}${ext}`
}

type PlanRow = {
    item: SelectItem
    entry: Entry // for FileIcon
    oldName: string
    newName: string
    target: string // full path after the rename, used to check for collisions in each folder
    error?: string
}

// Maps the selection to old→new rows and flags anything that would make renaming them one by
// one unsafe. That includes empty names, two items renamed to the same target, and a target that
// is the current name of another selected item. With an invalid regex, every name is left
// unchanged and the banner blocks Apply.
function buildPlan(
    items: SelectItem[],
    form: RenameForm
): { rows: PlanRow[]; regexError?: string } {
    const { find, error: regexError } = compileFind(form)

    const rows = items.map((item, index) => {
        const oldName = baseName(item.path)
        const isDir = item.type === 'folder'
        const dir = item.path.slice(0, item.path.lastIndexOf(oldName))
        const newName = regexError ? oldName : computeNewName(oldName, isDir, index, form, find)
        return {
            item,
            entry: { key: item.path, name: oldName, isDir, fullPath: item.path },
            oldName,
            newName,
            target: dir + newName,
        }
    })

    const targetCounts = new Map<string, number>()
    for (const row of rows) targetCounts.set(row.target, (targetCounts.get(row.target) ?? 0) + 1)
    const currentPaths = new Set(rows.map((row) => row.item.path))

    const errorFor = (row: Omit<PlanRow, 'error'>) => {
        if (!row.newName) return t`Name cannot be empty`
        if ((targetCounts.get(row.target) ?? 0) > 1) return t`Duplicate name`
        if (row.newName !== row.oldName && currentPaths.has(row.target)) {
            return t`Would collide with another selected item`
        }
        return undefined
    }

    return { regexError, rows: rows.map((row) => ({ ...row, error: errorFor(row) })) }
}

const LETTER_CASE = t({
    message: 'Case',
    comment: 'Heading: the letter case of the new names (lower, upper, title).',
})

const PREVIEW = t({
    message: 'Preview',
    context: 'heading',
    comment: 'Heading: each name before and after the rename.',
})

// Free-text fields (names, patterns) must not be autocorrected by the browser.
const PLAIN_TEXT = {
    autoCapitalize: 'off',
    autoComplete: 'off',
    autoCorrect: 'off',
    spellCheck: 'false',
} as const

/** Why the renames failed: the error, and the transfer that ran them when there was one. */
type Failure = { error: string; transferId?: string }

/** What the drawer says about a batch that ended in `state` without completing. */
function endedText(state: string): string {
    switch (state) {
        case 'failed':
            return t`The renames failed.`
        case 'stopped':
            return t`The renames were stopped.`
        case 'interrupted':
            return t`The renames were interrupted.`
        default:
            return t`The renames did not complete.`
    }
}

/** A transfer that ended without success. The drawer then shows how each rename went. */
type Ended = { transferId: string; state: string; rows: PlanRow[] }

export default function BatchRenameDrawer({
    isOpen,
    onClose,
    items,
    onDone,
}: {
    isOpen: boolean
    onClose: () => void
    items: SelectItem[]
    /** Called when the renames start, with the id of the transfer that records them. */
    onDone: (transferId: string | undefined) => void
}) {
    const [form, setForm] = useState<RenameForm>(INITIAL_FORM)
    const [failure, setFailure] = useState<Failure | null>(null)
    const [isStarting, setIsStarting] = useState(false)
    // The transfer that runs the renames, until it ends, and the rows sent to it, in order.
    const [running, setRunning] = useState<{ transferId: string; rows: PlanRow[] } | null>(null)
    const [ended, setEnded] = useState<Ended | null>(null)
    // The failures of the ended transfer, grouped by the rename that each belongs to.
    const { retryable, query: retryableQuery } = useRetryable(ended?.transferId)
    // The renames made while the drawer is open, keyed by the item's path, with each new name.
    // Apply sends only the remaining renames. The renames of the last transfer are added once its
    // failures are known.
    const [renamed, setRenamed] = useState<ReadonlyMap<string, string>>(new Map())
    const done = useMemo(() => {
        const last = ended && retryable ? renamesDone(ended.state, ended.rows, retryable.items) : []
        if (last.length === 0) return renamed
        return new Map([...renamed, ...last.map((row) => [row.item.path, row.newName] as const)])
    }, [renamed, ended, retryable])

    useEffect(() => {
        if (isOpen) {
            setForm(INITIAL_FORM)
            setFailure(null)
            setRunning(null)
            setEnded(null)
            setRenamed(new Map())
        }
    }, [isOpen])

    const patch = (partial: Partial<RenameForm>) => setForm((prev) => ({ ...prev, ...partial }))

    const { rows, regexError } = useMemo(() => buildPlan(items, form), [items, form])
    const left = rows.filter((row) => !done.has(row.item.path))
    const pending = left.filter((row) => !row.error && row.newName !== row.oldName)
    // Apply stays disabled while the last transfer's failures are loading, because until then
    // it isn't known which renames succeeded.
    const applyDisabled =
        !!regexError ||
        left.some((row) => row.error) ||
        pending.length === 0 ||
        (ended !== null && retryableQuery.isLoading)

    // The core runs the plan as one recorded transfer. It renames one item at a time, which is
    // what the collision checks assume. It refuses the whole batch up front when a new name is
    // already taken.
    const apply = async () => {
        setIsStarting(true)
        setFailure(null)
        setRenamed(done)
        setEnded(null)
        const sent = pending
        try {
            const transferId = await batchRename(
                sent.map((row) => ({
                    path: row.item.path,
                    isDir: row.item.type === 'folder',
                    newName: row.newName,
                }))
            )
            onDone(transferId || undefined)
            if (transferId) setRunning({ transferId, rows: sent })
            else onClose()
        } catch (error) {
            setFailure({ error: formatErrorMessage(error, t`Rename failed`) })
        } finally {
            setIsStarting(false)
        }
    }

    // Close the drawer once the transfer has done every rename. Otherwise keep it open, list the
    // renames that failed and why, and link to the transfer. A small batch can end before the
    // transfer id is returned, and `onTransferEnd` handles that case. If the core has no record of
    // the transfer, say so, with no link.
    useEffect(() => {
        if (!running) return
        return onTransferEnd(running.transferId, (state) => {
            setRunning(null)
            if (state === 'completed') {
                onClose()
                return
            }
            if (state === ELSEWHERE) {
                setFailure({ error: t`The renames' transfer is no longer in History.` })
                return
            }
            setEnded({ ...running, state })
        })
    }, [running, onClose])

    const failedRenames = useMemo(
        () =>
            (retryable?.items ?? []).map((f) => {
                const name = (f.step === null ? undefined : ended?.rows[f.step]?.oldName) ?? f.label
                return { name: f.kind === 'file' ? `${name}/${f.label}` : name, error: f.error }
            }),
        [retryable, ended]
    )
    const endedError = retryable?.general[0]?.error
    const shownFailure: Failure | null = ended
        ? {
              error:
                  failedRenames.length > 0
                      ? plural(failedRenames.length, {
                            one: '# rename failed:',
                            other: '# renames failed:',
                        })
                      : retryableQuery.isLoading
                        ? endedText(ended.state)
                        : endedError || endedText(ended.state),
              transferId: ended.transferId,
          }
        : failure

    const problems = left.filter((row) => row.error).length
    const numberingId = useId()
    const renameCount = formatNumber(pending.length)

    return (
        <ContentDrawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            title={t`Batch Rename`}
            icon={PenIcon}
            tone="blue"
            description={plural(items.length, { one: '# item', other: '# items' })}
            bodyClassName="p-0 overflow-hidden"
            footer={
                <>
                    <Button variant="flat" onPress={onClose} data-focus-visible="false">
                        <Trans>Cancel</Trans>
                    </Button>
                    <Button
                        color="primary"
                        className={toneButton('blue')}
                        isDisabled={applyDisabled}
                        isLoading={isStarting || running !== null}
                        onPress={apply}
                        data-focus-visible="false"
                    >
                        {pending.length > 0
                            ? t({
                                  message: `Rename ${renameCount}`,
                                  comment: 'Button: renames that many items, as in "Rename 12".',
                              })
                            : t({ message: 'Rename', comment: 'Button: renames the items.' })}
                    </Button>
                </>
            }
        >
            <div className="grid h-full min-h-0 md:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
                {/* The rules, in the order they apply. */}
                <ScrollShadow className="flex flex-col gap-5 px-5 py-5 overflow-y-auto md:border-r border-divider">
                    <RuleGroup title={t`Find and replace`}>
                        <div className="grid grid-cols-2 gap-3">
                            <Input
                                label={t({
                                    message: 'Find',
                                    comment: 'Label of the field for the text to find.',
                                })}
                                labelPlacement="outside"
                                placeholder={t`Text to find`}
                                value={form.find}
                                onValueChange={(v) => patch({ find: v })}
                                {...PLAIN_TEXT}
                            />
                            <Input
                                label={t`Replace with`}
                                labelPlacement="outside"
                                placeholder={t`Replacement`}
                                value={form.replace}
                                onValueChange={(v) => patch({ replace: v })}
                                {...PLAIN_TEXT}
                            />
                        </div>
                        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                            <Switch
                                size="sm"
                                isSelected={form.regex}
                                onValueChange={(v) => patch({ regex: v })}
                            >
                                {t({
                                    message: 'Regex',
                                    comment: 'Switch: the text to find is a regular expression.',
                                })}
                            </Switch>
                            <Switch
                                size="sm"
                                isSelected={form.caseInsensitive}
                                onValueChange={(v) => patch({ caseInsensitive: v })}
                            >
                                <Trans>Case-insensitive</Trans>
                            </Switch>
                        </div>
                        {regexError && (
                            <p className="flex items-center gap-2 text-xs text-danger">
                                <ExclamationCircleIcon className="size-4 shrink-0" />
                                {regexError}
                            </p>
                        )}
                    </RuleGroup>

                    <RuleGroup title={t`Add text`}>
                        <div className="grid grid-cols-2 gap-3">
                            <Input
                                label={t`Prefix`}
                                labelPlacement="outside"
                                placeholder={t`Added to the start`}
                                value={form.prefix}
                                onValueChange={(v) => patch({ prefix: v })}
                                {...PLAIN_TEXT}
                            />
                            <Input
                                label={t`Suffix`}
                                labelPlacement="outside"
                                placeholder={t`Added before the extension`}
                                value={form.suffix}
                                onValueChange={(v) => patch({ suffix: v })}
                                {...PLAIN_TEXT}
                            />
                        </div>
                    </RuleGroup>

                    <RuleGroup
                        title={t`Numbering`}
                        titleId={numberingId}
                        action={
                            <Switch
                                size="sm"
                                // HeroUI's Switch drops aria-label without children, so the
                                // group's title names it.
                                aria-labelledby={numberingId}
                                isSelected={form.numberEnabled}
                                onValueChange={(v) => patch({ numberEnabled: v })}
                                classNames={{ wrapper: 'me-0' }}
                            />
                        }
                    >
                        {form.numberEnabled ? (
                            <div className="grid grid-cols-3 gap-3">
                                <Input
                                    type="number"
                                    label={t`Start at`}
                                    labelPlacement="outside"
                                    value={String(form.numberStart)}
                                    onValueChange={(v) =>
                                        patch({
                                            numberStart: Number.parseInt(v, 10) || 0,
                                        })
                                    }
                                />
                                <Input
                                    type="number"
                                    label={t`Min digits`}
                                    labelPlacement="outside"
                                    value={String(form.numberPadding)}
                                    onValueChange={(v) =>
                                        patch({
                                            numberPadding: Math.max(0, Number.parseInt(v, 10) || 0),
                                        })
                                    }
                                />
                                <Input
                                    label={t`Separator`}
                                    labelPlacement="outside"
                                    placeholder={t`e.g. - or _`}
                                    value={form.numberSeparator}
                                    onValueChange={(v) => patch({ numberSeparator: v })}
                                    {...PLAIN_TEXT}
                                />
                            </div>
                        ) : (
                            <p className="text-xs text-default-500">
                                <Trans>
                                    Add a sequential number: each name gets the next one, after the
                                    suffix.
                                </Trans>
                            </p>
                        )}
                    </RuleGroup>

                    <RuleGroup title={LETTER_CASE}>
                        <RadioGroup
                            aria-label={LETTER_CASE}
                            orientation="horizontal"
                            value={form.caseMode}
                            onValueChange={(v) => patch({ caseMode: v as CaseMode })}
                            size="sm"
                        >
                            <Radio value="none">
                                {t({
                                    message: 'Original',
                                    comment: 'Letter case option: names keep the case they have.',
                                })}
                            </Radio>
                            <Radio value="lower">
                                {t({
                                    message: 'lower',
                                    comment:
                                        'Letter case option: lower case, written in lower case.',
                                })}
                            </Radio>
                            <Radio value="upper">
                                {t({
                                    message: 'UPPER',
                                    comment:
                                        'Letter case option: upper case, written in upper case.',
                                })}
                            </Radio>
                            <Radio value="title">
                                {t({
                                    message: 'Title',
                                    comment:
                                        'Letter case option: Title Case, each word starts with a capital.',
                                })}
                            </Radio>
                        </RadioGroup>
                        <Switch
                            size="sm"
                            isSelected={form.includeExtension}
                            onValueChange={(v) => patch({ includeExtension: v })}
                        >
                            <Trans>Include extension</Trans>
                        </Switch>
                    </RuleGroup>
                </ScrollShadow>

                <section
                    aria-label={PREVIEW}
                    className="flex flex-col min-h-0 gap-3 px-5 py-5 max-md:border-t border-divider"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-[15px] font-semibold">{PREVIEW}</h3>
                        <Chip
                            size="sm"
                            variant="flat"
                            color={pending.length > 0 ? 'primary' : 'default'}
                        >
                            {plural(pending.length, { one: '# to rename', other: '# to rename' })}
                        </Chip>
                        {problems > 0 && (
                            <Chip size="sm" variant="flat" color="danger">
                                {plural(problems, { one: '# problem', other: '# problems' })}
                            </Chip>
                        )}
                    </div>

                    {shownFailure && (
                        <div
                            role="alert"
                            className="flex flex-col gap-1 p-3 text-xs rounded-xl bg-danger/10 text-danger-600 dark:text-danger-500"
                        >
                            <span className="text-sm font-medium">{shownFailure.error}</span>
                            {failedRenames.map((f) => (
                                <span key={`${f.name}:${f.error}`}>
                                    {f.name}: {f.error}
                                </span>
                            ))}
                            {shownFailure.transferId && (
                                <button
                                    type="button"
                                    className="self-start underline"
                                    onClick={() => openHistory(shownFailure.transferId)}
                                >
                                    <Trans>The transfer lists each rename and how it went.</Trans>
                                </button>
                            )}
                        </div>
                    )}

                    <ScrollShadow className={cn('flex-1 min-h-0', SURFACE, 'rounded-xl')}>
                        {rows.map((row) => {
                            // A completed rename shows its new name.
                            const made = done.get(row.item.path)
                            const newName = made ?? row.newName
                            const error = made === undefined ? row.error : undefined
                            const changes = made === undefined && newName !== row.oldName
                            return (
                                <div
                                    key={row.item.path}
                                    className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3.5 py-2 border-b border-divider last:border-b-0"
                                >
                                    <div className="flex items-center min-w-0 gap-2.5">
                                        <FileIcon entry={row.entry} size="sm" />
                                        <span
                                            className={cn(
                                                'text-[13px] truncate',
                                                changes || error
                                                    ? 'text-default-500'
                                                    : 'text-foreground'
                                            )}
                                            title={row.oldName}
                                        >
                                            {row.oldName}
                                        </span>
                                    </div>
                                    <ArrowRightSmallIcon
                                        className={cn(
                                            'size-4 shrink-0',
                                            error
                                                ? 'text-danger'
                                                : changes
                                                  ? 'text-primary'
                                                  : 'text-default-300'
                                        )}
                                    />
                                    <div className="flex flex-col min-w-0">
                                        <span
                                            className={cn(
                                                'truncate text-[13px]',
                                                error
                                                    ? 'text-danger'
                                                    : changes
                                                      ? 'font-medium text-foreground'
                                                      : 'text-default-400'
                                            )}
                                            title={newName}
                                        >
                                            {newName || '—'}
                                        </span>
                                        {error && (
                                            <span className="text-[11px] text-danger">{error}</span>
                                        )}
                                        {made !== undefined && (
                                            <span className="text-[11px] text-success-600 dark:text-success">
                                                {t({
                                                    message: 'Renamed',
                                                    comment: 'Under a name: this item was renamed.',
                                                })}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )
                        })}
                    </ScrollShadow>
                </section>
            </div>
        </ContentDrawer>
    )
}

function RuleGroup({
    title,
    titleId,
    action,
    children,
}: {
    title: string
    titleId?: string
    action?: ReactNode
    children: ReactNode
}) {
    return (
        <section className={cn('flex flex-col gap-3 p-4', SURFACE, 'rounded-xl')}>
            <div className="flex items-center justify-between gap-3">
                <h3 id={titleId} className="text-[13px] font-semibold">
                    {title}
                </h3>
                {action}
            </div>
            {children}
        </section>
    )
}
