import {
    Chip,
    cn,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Textarea,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { AngleDownSmall as AngleDownSmallIcon } from '@zappicon/react'
import { startTransition, useMemo, useRef } from 'react'
import type { OptionValue } from '../../lib/catalog'
import { replaceSmartQuotes } from '../../lib/format'
import type { FlagValue } from '../../types/rclone'
import MetadataMapper from './MetadataMapper'
import { typeEnter, typeQuote } from './optionsTyping'
import {
    type AvailableOption,
    buildSelectorPresets,
    defaultValue,
    parseOptions,
    toOptionValue,
} from './optionValues'

const REMOVE = 'remove'

export default function OptionGroupEditor({
    label,
    optionsJson,
    setOptionsJson,
    globalOptions,
    availableOptions,
    mapperPaths,
    mapperRemoteOverrides,
    refusal,
}: {
    label?: string
    optionsJson: string
    setOptionsJson: (value: string) => void
    globalOptions: Record<string, OptionValue>
    availableOptions: AvailableOption[]
    mapperPaths?: { source?: string; destination?: string }
    mapperRemoteOverrides?: Record<string, Record<string, FlagValue>>
    refusal?: string
}) {
    const lastGood = useRef<Record<string, FlagValue>>({})
    const current = useMemo(() => {
        const parsed = parseOptions(optionsJson)
        if (parsed) lastGood.current = parsed
        return parsed
    }, [optionsJson])
    const isJsonValid = current !== undefined
    const options = current ?? lastGood.current
    const mapper = current?.metadata_mapper
    const optionsProblem = current ? refusal : undefined

    const presetsByName = useMemo(
        () =>
            Object.fromEntries(
                availableOptions.map((option) => [option.name, buildSelectorPresets(option)])
            ),
        [availableOptions]
    )

    const write = (next: Record<string, unknown>) =>
        startTransition(() => setOptionsJson(JSON.stringify(next, null, 2)))

    const toggle = (option: AvailableOption) => {
        if (options[option.name] !== undefined) {
            write({ ...options, [option.name]: undefined })
            return
        }
        const value = toOptionValue(globalOptions[option.name] ?? defaultValue(option), option.kind)
        write({
            ...options,
            [option.name]: value,
            ...(option.name === 'metadata_mapper' ? { metadata: true } : {}),
        })
    }

    return (
        <div className="flex flex-col gap-4">
            {mapper !== undefined && (
                <MetadataMapper
                    value={mapper as FlagValue}
                    paths={mapperPaths}
                    remoteOverrides={mapperRemoteOverrides}
                    onChange={(nextValue) =>
                        setOptionsJson(
                            JSON.stringify({ ...current, metadata_mapper: nextValue }, null, 2)
                        )
                    }
                />
            )}
            <div className="flex flex-row gap-3 h-[355px]">
                <div className="w-1/2">
                    <Textarea
                        classNames={{
                            base: 'w-full h-full',
                            inputWrapper:
                                'h-full! ring-0! outline-offset-0! outline-0! rounded-xl shadow-none bg-default-100/80 data-[hover=true]:bg-default-100 group-data-[focus=true]:bg-default-100',
                            input: 'font-mono text-small leading-relaxed',
                            label: 'font-medium text-default-500',
                        }}
                        label={label || t`Options as JSON`}
                        description={t`Type here, or tap an option on the right to add it.`}
                        value={optionsJson}
                        onValueChange={(value) => {
                            setOptionsJson(replaceSmartQuotes(value))
                        }}
                        onKeyDown={(e) => {
                            const field = e.currentTarget
                            if (e.key === 'Tab') {
                                e.preventDefault()
                                const text = field.value
                                const cursorPosition = field.selectionStart

                                const lineStart = text.lastIndexOf('\n', cursorPosition - 1) + 1
                                const lineEnd = text.indexOf('\n', cursorPosition)
                                const actualLineEnd = lineEnd === -1 ? text.length : lineEnd
                                const lineText = text.slice(lineStart, actualLineEnd)
                                const relCursor = cursorPosition - lineStart

                                const quoteIndices: number[] = []
                                for (let i = 0; i < lineText.length; i++) {
                                    if (
                                        lineText[i] === '"' &&
                                        (i === 0 || lineText[i - 1] !== '\\')
                                    ) {
                                        quoteIndices.push(i)
                                    }
                                }

                                if (quoteIndices.length >= 3) {
                                    const [startKey, endKey, startValue] = quoteIndices
                                    if (relCursor > startKey && relCursor <= endKey) {
                                        const next = lineStart + startValue + 1
                                        field.selectionStart = next
                                        field.selectionEnd = next
                                        return
                                    }
                                }

                                const newText = `${text.slice(0, cursorPosition)}  ${text.slice(cursorPosition)}`
                                setOptionsJson(newText)
                                field.value = newText
                                field.selectionStart = cursorPosition + 2
                                field.selectionEnd = cursorPosition + 2
                                return
                            }
                            if (e.key !== '"' && e.key !== 'Enter') return
                            const type = e.key === '"' ? typeQuote : typeEnter
                            const edit = type(field.value, field.selectionStart, field.selectionEnd)
                            if (!edit) return
                            e.preventDefault()
                            if (edit.text !== field.value) {
                                setOptionsJson(edit.text)
                                field.value = edit.text
                            }
                            field.selectionStart = edit.cursor
                            field.selectionEnd = edit.cursor
                        }}
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                        isInvalid={!isJsonValid || !!optionsProblem}
                        errorMessage={isJsonValid ? optionsProblem : t`Invalid JSON`}
                        disableAutosize={true}
                        rows={12}
                        size="lg"
                        onClear={() => {
                            setOptionsJson(JSON.stringify({}, null, 2))
                        }}
                        data-focus-visible="false"
                    />
                </div>

                <div className="flex flex-row flex-wrap items-start content-start justify-start w-1/2 p-0.5 overflow-y-auto gap-x-2 gap-y-2 rounded-medium">
                    {availableOptions.map((option) => {
                        const name = option.name
                        const added = options[option.name] !== undefined
                        const presets = presetsByName[option.name] ?? []
                        const chip = (
                            <Chip
                                isDisabled={!isJsonValid}
                                variant="flat"
                                color={added ? 'primary' : 'default'}
                                onClick={presets.length > 0 ? undefined : () => toggle(option)}
                                endContent={
                                    presets.length > 0 ? (
                                        <AngleDownSmallIcon className="size-3.5 opacity-70" />
                                    ) : undefined
                                }
                                classNames={{
                                    base: cn(
                                        'transition-colors duration-150',
                                        added
                                            ? 'shadow-[inset_0_0_0_1px_hsl(var(--heroui-primary)/0.6)] text-primary-700 dark:text-primary-400'
                                            : 'bg-default-100 text-default-700 hover:bg-default-200'
                                    ),
                                    content: 'cursor-pointer! font-mono text-tiny',
                                }}
                                size="sm"
                                as="button"
                            >
                                {option.name}
                            </Chip>
                        )
                        const tooltip = {
                            content: (
                                <div className="flex flex-col w-full gap-1 overflow-y-auto max-w-52 max-h-80 overscroll-y-none">
                                    <p className="sticky top-0 font-mono font-bold truncate bg-foreground shrink-0">
                                        {option.name}
                                    </p>
                                    <p>{option.help}</p>
                                </div>
                            ),
                            delay: 500,
                            closeDelay: 0,
                            className: 'pt-1.5 max-w-52',
                            color: 'foreground',
                        } as const
                        if (presets.length === 0) {
                            return (
                                <Tooltip key={option.name} {...tooltip}>
                                    {chip}
                                </Tooltip>
                            )
                        }
                        const items = [
                            ...presets.map((preset, index) => {
                                const value = preset.label
                                return {
                                    key: String(index),
                                    label: preset.isDefault
                                        ? t({
                                              message: `${value} (default)`,
                                              comment:
                                                  "A value in an option's menu, which is rclone's default.",
                                          })
                                        : value,
                                }
                            }),
                            ...(added
                                ? [
                                      {
                                          key: REMOVE,
                                          label: t({
                                              message: 'Remove',
                                              comment:
                                                  'Menu item: takes the option out of the group.',
                                          }),
                                      },
                                  ]
                                : []),
                        ]
                        return (
                            <Dropdown key={option.name} shadow="none" isDisabled={!isJsonValid}>
                                <Tooltip {...tooltip}>
                                    <div tabIndex={-1}>
                                        <DropdownTrigger>{chip}</DropdownTrigger>
                                    </div>
                                </Tooltip>
                                <DropdownMenu
                                    aria-label={t`Values of ${name}`}
                                    items={items}
                                    onAction={(key) => {
                                        if (key === REMOVE) {
                                            toggle(option)
                                            return
                                        }
                                        const preset = presets[Number(key)]
                                        if (!preset) return
                                        write({
                                            ...options,
                                            [option.name]: JSON.parse(preset.token) as FlagValue,
                                        })
                                    }}
                                >
                                    {(item) => (
                                        <DropdownItem
                                            key={item.key}
                                            className={
                                                item.key === REMOVE ? 'text-danger' : undefined
                                            }
                                            color={item.key === REMOVE ? 'danger' : 'default'}
                                        >
                                            {item.label}
                                        </DropdownItem>
                                    )}
                                </DropdownMenu>
                            </Dropdown>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
