import {
    Button,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
    Radio,
    RadioGroup,
    ScrollShadow,
    Switch,
    cn,
} from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { AlertCircleIcon, ArrowRightIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getFsInfo } from '../../../lib/format.ts'
import FileIcon from './FileIcon'
import type { Entry, SelectItem } from './types'
import { renamePath } from './utils'

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

// The find/replace pattern, compiled once per plan; `error` when the user's regex doesn't parse.
function compileFind(form: RenameForm): { find?: RegExp; error?: string } {
    if (!form.find) return {}
    try {
        const source = form.regex ? form.find : form.find.replace(RE_REGEXP_META, '\\$&')
        return { find: new RegExp(source, form.caseInsensitive ? 'gi' : 'g') }
    } catch {
        return { error: 'Invalid regular expression' }
    }
}

// prefix + (find/replace → case) + suffix + number, with the extension re-attached last.
function computeNewName(
    oldName: string,
    isDir: boolean,
    index: number,
    form: RenameForm,
    find?: RegExp
): string {
    // Folders never have an extension; for files, split on the last dot unless the user opted to
    // include it. `dot > 0` keeps dotfiles (".env") whole.
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
    target: string // full path after the rename; collisions are checked per folder
    error?: string
}

// Maps the selection to old→new rows and flags anything that would make a sequential rename unsafe:
// empty names, two items renamed to the same target, or a target that is another selected item's
// current name. With an invalid regex every name is left unchanged and the banner blocks Apply.
function buildPlan(
    items: SelectItem[],
    form: RenameForm
): { rows: PlanRow[]; regexError?: string } {
    const { find, error: regexError } = compileFind(form)

    const rows = items.map((item, index) => {
        const oldName = getFsInfo(item.path).name
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
        if (!row.newName) return 'Name cannot be empty'
        if ((targetCounts.get(row.target) ?? 0) > 1) return 'Duplicate name'
        if (row.newName !== row.oldName && currentPaths.has(row.target)) {
            return 'Would collide with another selected item'
        }
        return undefined
    }

    return { regexError, rows: rows.map((row) => ({ ...row, error: errorFor(row) })) }
}

// Free-text fields (names, patterns) must not be autocorrected by the webview.
const PLAIN_TEXT = {
    autoCapitalize: 'off',
    autoComplete: 'off',
    autoCorrect: 'off',
    spellCheck: 'false',
} as const

export default function BatchRenameDrawer({
    isOpen,
    onClose,
    items,
    onDone,
}: {
    isOpen: boolean
    onClose: () => void
    items: SelectItem[]
    onDone: () => void
}) {
    const [form, setForm] = useState<RenameForm>(INITIAL_FORM)
    const [failures, setFailures] = useState<{ name: string; error: string }[]>([])

    // Fresh form each time the drawer opens.
    useEffect(() => {
        if (isOpen) {
            setForm(INITIAL_FORM)
            setFailures([])
        }
    }, [isOpen])

    const patch = (partial: Partial<RenameForm>) => setForm((prev) => ({ ...prev, ...partial }))

    const { rows, regexError } = useMemo(() => buildPlan(items, form), [items, form])
    const pending = rows.filter((row) => !row.error && row.newName !== row.oldName)
    const applyDisabled = !!regexError || rows.some((row) => row.error) || pending.length === 0

    const applyMutation = useMutation({
        // Sequential on purpose: the plan's collision checks assume renames happen one at a time.
        mutationFn: async () => {
            const failed: { name: string; error: string }[] = []
            for (const row of pending) {
                try {
                    await renamePath(row.item.path, row.item.type === 'folder', row.newName)
                } catch (error) {
                    failed.push({
                        name: row.oldName,
                        error: error instanceof Error ? error.message : 'Rename failed',
                    })
                }
            }
            return failed
        },
        onSuccess: (failed) => {
            onDone()
            if (failed.length === 0) onClose()
            else setFailures(failed)
        },
    })

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent className="bg-content1/80 backdrop-blur-md dark:bg-content1/90">
                {() => (
                    <>
                        <DrawerHeader className="flex items-center justify-between border-b border-divider">
                            <span className="text-base font-semibold">
                                Batch Rename
                                <span className="ml-2 font-normal text-default-400">
                                    {items.length} items
                                </span>
                            </span>
                            <Button isIconOnly={true} size="sm" variant="light" onPress={onClose}>
                                <XIcon className="size-4" />
                            </Button>
                        </DrawerHeader>

                        <DrawerBody className="flex flex-col gap-5 overflow-hidden">
                            <div className="flex flex-col gap-5">
                                <section className="flex flex-col gap-2">
                                    <div className="grid grid-cols-2 gap-3">
                                        <Input
                                            label="Find"
                                            labelPlacement="outside"
                                            placeholder="Text to find"
                                            value={form.find}
                                            onValueChange={(v) => patch({ find: v })}
                                            {...PLAIN_TEXT}
                                        />
                                        <Input
                                            label="Replace with"
                                            labelPlacement="outside"
                                            placeholder="Replacement"
                                            value={form.replace}
                                            onValueChange={(v) => patch({ replace: v })}
                                            {...PLAIN_TEXT}
                                        />
                                    </div>
                                    <div className="flex items-center gap-6">
                                        <Switch
                                            size="sm"
                                            isSelected={form.regex}
                                            onValueChange={(v) => patch({ regex: v })}
                                        >
                                            Regex
                                        </Switch>
                                        <Switch
                                            size="sm"
                                            isSelected={form.caseInsensitive}
                                            onValueChange={(v) => patch({ caseInsensitive: v })}
                                        >
                                            Case-insensitive
                                        </Switch>
                                    </div>
                                </section>

                                <section className="grid grid-cols-2 gap-3">
                                    <Input
                                        label="Prefix"
                                        labelPlacement="outside"
                                        placeholder="Added to the start"
                                        value={form.prefix}
                                        onValueChange={(v) => patch({ prefix: v })}
                                        {...PLAIN_TEXT}
                                    />
                                    <Input
                                        label="Suffix"
                                        labelPlacement="outside"
                                        placeholder="Added before the extension"
                                        value={form.suffix}
                                        onValueChange={(v) => patch({ suffix: v })}
                                        {...PLAIN_TEXT}
                                    />
                                </section>

                                <section className="flex flex-col gap-2">
                                    <Switch
                                        size="sm"
                                        isSelected={form.numberEnabled}
                                        onValueChange={(v) => patch({ numberEnabled: v })}
                                    >
                                        Add sequential number
                                    </Switch>
                                    {form.numberEnabled && (
                                        <div className="grid grid-cols-3 gap-3">
                                            <Input
                                                type="number"
                                                label="Start at"
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
                                                label="Min digits"
                                                labelPlacement="outside"
                                                value={String(form.numberPadding)}
                                                onValueChange={(v) =>
                                                    patch({
                                                        numberPadding: Math.max(
                                                            0,
                                                            Number.parseInt(v, 10) || 0
                                                        ),
                                                    })
                                                }
                                            />
                                            <Input
                                                label="Separator"
                                                labelPlacement="outside"
                                                placeholder="e.g. - or _"
                                                value={form.numberSeparator}
                                                onValueChange={(v) => patch({ numberSeparator: v })}
                                                {...PLAIN_TEXT}
                                            />
                                        </div>
                                    )}
                                </section>

                                <section className="flex flex-wrap items-center justify-between gap-4">
                                    <RadioGroup
                                        label="Case"
                                        orientation="horizontal"
                                        value={form.caseMode}
                                        onValueChange={(v) => patch({ caseMode: v as CaseMode })}
                                        size="sm"
                                    >
                                        <Radio value="none">Original</Radio>
                                        <Radio value="lower">lower</Radio>
                                        <Radio value="upper">UPPER</Radio>
                                        <Radio value="title">Title</Radio>
                                    </RadioGroup>
                                    <Switch
                                        size="sm"
                                        isSelected={form.includeExtension}
                                        onValueChange={(v) => patch({ includeExtension: v })}
                                    >
                                        Include extension
                                    </Switch>
                                </section>

                                {regexError && (
                                    <div className="flex items-center gap-2 text-sm text-danger">
                                        <AlertCircleIcon className="size-4" />
                                        {regexError}
                                    </div>
                                )}
                                {failures.length > 0 && (
                                    <div className="flex flex-col gap-1 text-sm text-danger">
                                        <span className="font-medium">
                                            {failures.length} rename(s) failed:
                                        </span>
                                        {failures.map((f) => (
                                            <span key={f.name} className="text-xs">
                                                {f.name}: {f.error}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="flex flex-col flex-1 min-h-0">
                                <span className="mb-1 text-xs font-medium text-default-400">
                                    Preview
                                </span>
                                <ScrollShadow className="flex-1 border rounded-lg border-divider">
                                    {rows.map((row) => (
                                        <div
                                            key={row.item.path}
                                            className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 py-2 border-b border-divider last:border-b-0"
                                        >
                                            <div className="flex items-center min-w-0 gap-2">
                                                <FileIcon entry={row.entry} size="sm" />
                                                <span
                                                    className="text-sm truncate text-default-500"
                                                    title={row.oldName}
                                                >
                                                    {row.oldName}
                                                </span>
                                            </div>
                                            <ArrowRightIcon className="size-4 text-default-300 shrink-0" />
                                            <div className="flex flex-col min-w-0">
                                                <span
                                                    className={cn(
                                                        'truncate text-sm',
                                                        row.error
                                                            ? 'text-danger'
                                                            : row.newName !== row.oldName
                                                              ? 'font-medium text-foreground'
                                                              : 'text-default-400'
                                                    )}
                                                    title={row.newName}
                                                >
                                                    {row.newName || '—'}
                                                </span>
                                                {row.error && (
                                                    <span className="text-xs text-danger">
                                                        {row.error}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </ScrollShadow>
                            </div>
                        </DrawerBody>

                        <DrawerFooter className="border-t border-divider">
                            <Button variant="light" onPress={onClose} data-focus-visible="false">
                                Cancel
                            </Button>
                            <Button
                                color="primary"
                                isDisabled={applyDisabled}
                                isLoading={applyMutation.isPending}
                                onPress={() => applyMutation.mutate()}
                                data-focus-visible="false"
                            >
                                {pending.length > 0 ? `Rename ${pending.length}` : 'Rename'}
                            </Button>
                        </DrawerFooter>
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
