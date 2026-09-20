import {
    Chip,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Textarea,
    Tooltip,
} from '@heroui/react'
import { ChevronDownIcon, LockKeyholeIcon, LockOpenIcon } from 'lucide-react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { replaceSmartQuotes } from '@/lib/format'
import { metadataOptionsProblem } from '@/lib/rclone/metadataMapper'
import {
    optionChoices,
    parseBooleanString,
    parseTristateString,
    toOptionValue,
} from '@/lib/rclone/optionTypes'
import type { FlagValue } from '@/lib/rclone/types'
import MetadataMapper from './MetadataMapper'

type AvailableOption = {
    Name: string
    FieldName: string
    Help: string
    DefaultStr: string
    Type: string
    Examples?: Array<{ Value: string; Help: string }>
}

type SelectorPreset = {
    label: string
    token: string
    isDefault: boolean
}

type DecorationState = {
    key: string
    valueStart: number
    valueEnd: number
    rowTop: number
}

const DECORATION_BUTTON =
    'flex items-center justify-center transition-colors border shadow-sm pointer-events-auto size-6 rounded-small text-foreground-500 bg-content2/90 hover:bg-content2 hover:text-foreground-700 border-divider/60'

function isDigit(char: string) {
    return char >= '0' && char <= '9'
}

function serializePresetToken(value: string, optionType: string): string | null {
    const normalizedType = optionType.toLowerCase()

    if (normalizedType === 'bool') {
        const parsed = parseBooleanString(value)
        return parsed === null ? null : String(parsed)
    }

    if (normalizedType === 'tristate') {
        const parsed = parseTristateString(value)
        if (parsed === undefined) {
            return null
        }
        if (parsed === null) {
            return 'null'
        }
        return String(parsed)
    }

    if (normalizedType.includes('int') || normalizedType.includes('float')) {
        const parsedNumber = Number(value)
        if (!Number.isFinite(parsedNumber)) {
            return null
        }
        return String(parsedNumber)
    }

    return JSON.stringify(value)
}

function formatPresetLabel(value: string, token: string) {
    if (token === 'true' || token === 'false' || token === 'null') {
        return token
    }
    if (value.length === 0) {
        return '""'
    }
    return value
}

function buildSelectorPresets(option: AvailableOption): SelectorPreset[] {
    const choices = optionChoices(option)
    if (!choices) {
        return []
    }

    const presets: SelectorPreset[] = []
    const seenTokens = new Set<string>()

    const pushPreset = (value: string, isDefault: boolean) => {
        const token = serializePresetToken(value, option.Type)
        if (!token || seenTokens.has(token)) {
            return
        }

        seenTokens.add(token)
        presets.push({
            label: formatPresetLabel(value, token),
            token,
            isDefault,
        })
    }

    pushPreset(option.DefaultStr, true)

    for (const choice of choices.values) {
        pushPreset(choice.Value, false)
    }

    return presets
}

function scanJsonString(text: string, startIndex: number) {
    let index = startIndex + 1
    let escaped = false

    while (index < text.length) {
        const char = text[index]

        if (escaped) {
            escaped = false
            index += 1
            continue
        }

        if (char === '\\') {
            escaped = true
            index += 1
            continue
        }

        if (char === '"') {
            return index + 1
        }

        index += 1
    }

    return text.length
}

function scanJsonContainer(text: string, startIndex: number, openChar: string, closeChar: string) {
    let depth = 1
    let index = startIndex + 1

    while (index < text.length) {
        const char = text[index]

        if (char === '"') {
            index = scanJsonString(text, index)
            continue
        }

        if (char === openChar) {
            depth += 1
            index += 1
            continue
        }

        if (char === closeChar) {
            depth -= 1
            index += 1
            if (depth === 0) {
                return index
            }
            continue
        }

        index += 1
    }

    return text.length
}

function scanJsonNumber(text: string, startIndex: number) {
    let index = startIndex

    if (text[index] === '-') {
        index += 1
    }

    if (text[index] === '0') {
        index += 1
    } else {
        while (index < text.length && isDigit(text[index])) {
            index += 1
        }
    }

    if (text[index] === '.') {
        index += 1
        while (index < text.length && isDigit(text[index])) {
            index += 1
        }
    }

    if (text[index] === 'e' || text[index] === 'E') {
        index += 1
        if (text[index] === '+' || text[index] === '-') {
            index += 1
        }
        while (index < text.length && isDigit(text[index])) {
            index += 1
        }
    }

    return index
}

function scanJsonValue(text: string, startIndex: number) {
    const startChar = text[startIndex]

    if (startChar === '"') {
        return scanJsonString(text, startIndex)
    }

    if (startChar === '{') {
        return scanJsonContainer(text, startIndex, '{', '}')
    }

    if (startChar === '[') {
        return scanJsonContainer(text, startIndex, '[', ']')
    }

    if (text.startsWith('true', startIndex)) {
        return startIndex + 4
    }

    if (text.startsWith('false', startIndex)) {
        return startIndex + 5
    }

    if (text.startsWith('null', startIndex)) {
        return startIndex + 4
    }

    return scanJsonNumber(text, startIndex)
}

function isWhitespace(char: string) {
    return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

function skipWhitespace(text: string, startIndex: number) {
    let index = startIndex
    while (index < text.length && isWhitespace(text[index])) {
        index += 1
    }
    return index
}

function parseTopLevelValueRanges(text: string) {
    const valueRanges: Array<{
        key: string
        keyStart: number
        valueStart: number
        valueEnd: number
    }> = []

    let index = skipWhitespace(text, 0)
    if (text[index] !== '{') {
        return valueRanges
    }

    index += 1

    while (index < text.length) {
        index = skipWhitespace(text, index)

        if (text[index] === ',') {
            index += 1
            continue
        }

        if (text[index] === '}') {
            break
        }

        if (text[index] !== '"') {
            break
        }

        const keyTokenStart = index
        const keyTokenEnd = scanJsonString(text, keyTokenStart)
        const keyToken = text.slice(keyTokenStart, keyTokenEnd)
        let key = ''

        try {
            key = JSON.parse(keyToken) as string
        } catch {
            break
        }

        index = skipWhitespace(text, keyTokenEnd)
        if (text[index] !== ':') {
            break
        }
        index += 1
        index = skipWhitespace(text, index)

        const valueStart = index
        const valueEnd = scanJsonValue(text, valueStart)
        if (valueEnd <= valueStart) {
            break
        }

        valueRanges.push({
            key,
            keyStart: keyTokenStart,
            valueStart,
            valueEnd,
        })

        index = skipWhitespace(text, valueEnd)
        if (text[index] === ',') {
            index += 1
        }
    }

    return valueRanges
}

function measureWrappedTopOffsets(textarea: HTMLTextAreaElement, text: string, indices: number[]) {
    if (indices.length === 0 || typeof document === 'undefined') {
        return new Map<number, number>()
    }

    const computedStyle = window.getComputedStyle(textarea)
    const mirror = document.createElement('div')
    mirror.style.position = 'absolute'
    mirror.style.top = '0'
    mirror.style.left = '-99999px'
    mirror.style.visibility = 'hidden'
    mirror.style.pointerEvents = 'none'
    mirror.style.whiteSpace = 'pre-wrap'
    mirror.style.overflowWrap = 'break-word'
    mirror.style.wordBreak = 'break-word'
    mirror.style.boxSizing = 'border-box'
    mirror.style.width = `${textarea.clientWidth}px`
    mirror.style.font = computedStyle.font
    mirror.style.lineHeight = computedStyle.lineHeight
    mirror.style.letterSpacing = computedStyle.letterSpacing
    mirror.style.paddingTop = computedStyle.paddingTop
    mirror.style.paddingRight = computedStyle.paddingRight
    mirror.style.paddingBottom = computedStyle.paddingBottom
    mirror.style.paddingLeft = computedStyle.paddingLeft
    mirror.style.textIndent = computedStyle.textIndent
    mirror.style.textTransform = computedStyle.textTransform
    mirror.style.tabSize = computedStyle.tabSize
    mirror.style.border = '0'

    const mirrorContent = text.length > 0 ? text : ' '
    const textNode = document.createTextNode(mirrorContent)
    mirror.appendChild(textNode)
    document.body.appendChild(mirror)

    const mirrorRect = mirror.getBoundingClientRect()
    const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0
    const uniqueIndices = Array.from(new Set(indices))
    const topByIndex = new Map<number, number>()
    const range = document.createRange()

    for (const index of uniqueIndices) {
        const clampedIndex = Math.max(0, Math.min(index, mirrorContent.length))
        range.setStart(textNode, clampedIndex)
        range.setEnd(textNode, clampedIndex)

        let rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0 && mirrorContent.length > 0) {
            const fallbackStart = Math.max(0, Math.min(clampedIndex, mirrorContent.length - 1))
            range.setStart(textNode, fallbackStart)
            range.setEnd(textNode, fallbackStart + 1)
            rect = range.getBoundingClientRect()
        }

        const top = rect.top - mirrorRect.top - paddingTop
        topByIndex.set(index, Math.max(0, top))
    }

    document.body.removeChild(mirror)

    return topByIndex
}

function isSameDecoration(left: DecorationState | null, right: DecorationState | null) {
    if (!left || !right) {
        return left === right
    }

    return (
        left.key === right.key &&
        left.valueStart === right.valueStart &&
        left.valueEnd === right.valueEnd &&
        left.rowTop === right.rowTop
    )
}

export default function OptionsSection({
    label,
    optionsJson,
    setOptionsJson,
    globalOptions,
    availableOptions,
    isLocked,
    setIsLocked,
    mapperPaths,
    mapperRemoteOverrides,
}: {
    label?: string
    optionsJson: string
    setOptionsJson: (value: string) => void
    globalOptions: Record<string, unknown>
    availableOptions: Array<{
        Name: string
        FieldName: string
        Help: string
        DefaultStr: string
        Type: string
        Examples?: Array<{ Value: string; Help: string }>
    }>
    isLocked?: boolean
    setIsLocked?: (value: boolean) => void
    /** The two ends of the operation, so the metadata mapper can offer each backend's fields. */
    mapperPaths?: { source?: string; destination?: string }
    /** This operation's per-remote backend overrides, which decide what the destination writes. */
    mapperRemoteOverrides?: Record<string, Record<string, FlagValue>>
}) {
    const [options, setOptions] = useState<Record<string, unknown>>({})
    const [isJsonValid, setIsJsonValid] = useState(true)
    const [scrollTop, setScrollTop] = useState(0)
    const [textareaLayout, setTextareaLayout] = useState({
        lineHeight: 20,
        paddingTop: 0,
        textareaOffsetTop: 0,
        // Tracked so textModel (which measures line wrapping) recomputes on horizontal resize —
        // the ResizeObserver refreshes this state, giving the memo a dep that follows the DOM.
        clientWidth: 0,
    })
    const [activeDecoration, setActiveDecoration] = useState<DecorationState | null>(null)
    const [isSelectorOpen, setIsSelectorOpen] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const textareaBaseRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        startTransition(() => {
            try {
                const parsedOptions = JSON.parse(optionsJson)
                setOptions(parsedOptions as Record<string, unknown>)
                setIsJsonValid(true)
            } catch {
                setIsJsonValid(false)
            }
        })
    }, [optionsJson])

    // The JSON read on the spot, for the mapping panel, rather than through the transition
    // above, which lands a render later: what the panel writes has to come back to it in the
    // same render, or its own quick second edit would read as somebody else's change. Nothing
    // while the JSON is being typed into something that does not parse.
    const current = useMemo(() => {
        try {
            return JSON.parse(optionsJson) as Record<string, unknown>
        } catch {
            return undefined
        }
    }, [optionsJson])
    // `metadata_mapper` is a whole command line, which is no kind of thing to type into a JSON
    // string: while the flag is there, the panel at the top of the section is where it is written.
    const mapper = current?.metadata_mapper

    const refreshTextareaLayout = useCallback(() => {
        const textarea = textareaRef.current
        if (!textarea) {
            return
        }

        const computedStyle = window.getComputedStyle(textarea)
        const lineHeightFromStyle = Number.parseFloat(computedStyle.lineHeight)
        const fontSize = Number.parseFloat(computedStyle.fontSize)
        const lineHeight =
            Number.isFinite(lineHeightFromStyle) && lineHeightFromStyle > 0
                ? lineHeightFromStyle
                : fontSize * 1.4
        const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0
        const baseRect = textareaBaseRef.current?.getBoundingClientRect()
        const textareaRect = textarea.getBoundingClientRect()
        const textareaOffsetTop = baseRect ? textareaRect.top - baseRect.top : 0
        const clientWidth = textarea.clientWidth

        setTextareaLayout((previous) => {
            if (
                previous.lineHeight === lineHeight &&
                previous.paddingTop === paddingTop &&
                previous.textareaOffsetTop === textareaOffsetTop &&
                previous.clientWidth === clientWidth
            ) {
                return previous
            }

            return {
                lineHeight,
                paddingTop,
                textareaOffsetTop,
                clientWidth,
            }
        })

        setScrollTop(textarea.scrollTop)
    }, [])

    useEffect(() => {
        refreshTextareaLayout()

        const textarea = textareaRef.current
        if (!textarea) {
            return
        }

        const resizeObserver = new ResizeObserver(() => {
            refreshTextareaLayout()
        })
        resizeObserver.observe(textarea)

        return () => {
            resizeObserver.disconnect()
        }
    }, [refreshTextareaLayout])

    const isOptionAdded = useCallback(
        (option: string) => {
            return options[option] !== undefined
        },
        [options]
    )

    const presetByKey = useMemo(() => {
        return availableOptions.reduce(
            (acc, option) => {
                const presets = buildSelectorPresets(option)
                if (presets.length > 0) {
                    acc[option.Name] = presets
                }
                return acc
            },
            {} as Record<string, SelectorPreset[]>
        )
    }, [availableOptions])

    const textModel = useMemo(() => {
        const emptyModel = {
            rows: [] as Array<DecorationState & { rowBottom: number }>,
        }

        if (!isJsonValid || textareaLayout.lineHeight <= 0) {
            return emptyModel
        }

        const textarea = textareaRef.current
        if (!textarea) {
            return emptyModel
        }

        const topLevelEntries = parseTopLevelValueRanges(optionsJson).filter(
            (entry) => (presetByKey[entry.key]?.length ?? 0) > 0
        )

        if (topLevelEntries.length === 0) {
            return emptyModel
        }

        const lastEntry = topLevelEntries[topLevelEntries.length - 1]
        const indicesToMeasure = topLevelEntries.map((entry) => entry.keyStart)
        if (lastEntry) {
            indicesToMeasure.push(Math.max(lastEntry.valueStart, lastEntry.valueEnd - 1))
        }
        const topByIndex = measureWrappedTopOffsets(textarea, optionsJson, indicesToMeasure)

        const rows = topLevelEntries.map((entry, rowIndex) => {
            const rowTop = topByIndex.get(entry.keyStart) ?? rowIndex * textareaLayout.lineHeight

            return {
                key: entry.key,
                valueStart: entry.valueStart,
                valueEnd: entry.valueEnd,
                rowTop,
                rowBottom: rowTop + textareaLayout.lineHeight,
            }
        })

        for (let index = 0; index < rows.length - 1; index += 1) {
            const nextTop = rows[index + 1].rowTop
            if (nextTop > rows[index].rowTop) {
                rows[index].rowBottom = nextTop
            }
        }
        if (lastEntry && rows.length > 0) {
            const lastValueTop =
                topByIndex.get(Math.max(lastEntry.valueStart, lastEntry.valueEnd - 1)) ??
                rows[rows.length - 1].rowTop
            rows[rows.length - 1].rowBottom = Math.max(
                rows[rows.length - 1].rowTop + textareaLayout.lineHeight,
                lastValueTop + textareaLayout.lineHeight
            )
        }

        return {
            rows,
        }
    }, [isJsonValid, optionsJson, presetByKey, textareaLayout])

    const getDecorationFromPointer = useCallback(
        (clientY: number) => {
            const textarea = textareaRef.current
            if (!textarea) {
                return null
            }

            const rect = textarea.getBoundingClientRect()
            const relativeY = clientY - rect.top - textareaLayout.paddingTop + textarea.scrollTop

            if (relativeY < 0 || !Number.isFinite(relativeY)) {
                return null
            }

            const selectedRow = textModel.rows.find(
                (row) => relativeY >= row.rowTop && relativeY < row.rowBottom
            )
            if (!selectedRow) {
                return null
            }

            return {
                key: selectedRow.key,
                valueStart: selectedRow.valueStart,
                valueEnd: selectedRow.valueEnd,
                rowTop: selectedRow.rowTop,
            }
        },
        [textModel.rows, textareaLayout.paddingTop]
    )

    const applyPresetValue = useCallback(
        (token: string, decoration: DecorationState) => {
            const newText =
                optionsJson.slice(0, decoration.valueStart) +
                token +
                optionsJson.slice(decoration.valueEnd)

            const nextCursorPosition = decoration.valueStart + token.length
            setOptionsJson(newText)

            requestAnimationFrame(() => {
                if (!textareaRef.current) {
                    return
                }

                textareaRef.current.focus()
                textareaRef.current.selectionStart = nextCursorPosition
                textareaRef.current.selectionEnd = nextCursorPosition
            })
        },
        [optionsJson, setOptionsJson]
    )

    const activePresets = useMemo(() => {
        if (!activeDecoration) {
            return []
        }
        return presetByKey[activeDecoration.key] ?? []
    }, [activeDecoration, presetByKey])

    const optionsProblem = isJsonValid
        ? metadataOptionsProblem(options as Record<string, FlagValue>)
        : undefined
    const shouldShowSelector = isJsonValid && !!activeDecoration && activePresets.length > 0

    const decorationTop = shouldShowSelector
        ? textareaLayout.textareaOffsetTop +
          textareaLayout.paddingTop +
          activeDecoration!.rowTop -
          scrollTop
        : 0

    useEffect(() => {
        if (isJsonValid) {
            return
        }

        setIsSelectorOpen(false)
        setActiveDecoration(null)
    }, [isJsonValid])

    useEffect(() => {
        if (!activeDecoration) {
            return
        }

        const hasMatchingDecoration = textModel.rows.some(
            (candidate) =>
                candidate.key === activeDecoration.key &&
                candidate.valueStart === activeDecoration.valueStart &&
                candidate.valueEnd === activeDecoration.valueEnd &&
                candidate.rowTop === activeDecoration.rowTop
        )

        if (hasMatchingDecoration) {
            return
        }

        setIsSelectorOpen(false)
        setActiveDecoration(null)
    }, [activeDecoration, textModel.rows])

    return (
        <div className="flex flex-col gap-4">
            {mapper !== undefined && (
                <MetadataMapper
                    value={mapper as FlagValue}
                    paths={mapperPaths}
                    remoteOverrides={mapperRemoteOverrides}
                    onChange={(nextValue) => {
                        // The whole object is rewritten rather than the one value patched in
                        // place, which is the same rewrite (and the same formatting) every
                        // chip press does.
                        setOptionsJson(
                            JSON.stringify({ ...current, metadata_mapper: nextValue }, null, 2)
                        )
                    }}
                />
            )}
            <div className="flex flex-row gap-2 h-[355px]">
                <div
                    className="relative w-1/2"
                    onMouseMove={(event) => {
                        if (isSelectorOpen || !isJsonValid) {
                            return
                        }

                        const nextDecoration = getDecorationFromPointer(event.clientY)
                        setActiveDecoration((previous) => {
                            if (!nextDecoration) {
                                return previous ? null : previous
                            }
                            return isSameDecoration(previous, nextDecoration)
                                ? previous
                                : nextDecoration
                        })
                    }}
                    onMouseLeave={() => {
                        if (isSelectorOpen) {
                            return
                        }
                        setActiveDecoration(null)
                    }}
                >
                    <Textarea
                        ref={textareaRef}
                        baseRef={textareaBaseRef}
                        classNames={{
                            'base': 'w-full',
                            inputWrapper: '!h-full !ring-0 !outline-offset-0 !outline-0',
                            input: 'pr-9',
                        }}
                        label={label || 'Custom Options'}
                        description="Some lines show presets if you hover over them."
                        value={optionsJson}
                        onValueChange={(value) => {
                            //weird curly apostrophe alternatives on macos, replace to normal apostrophe
                            const cleanedJson = replaceSmartQuotes(value)
                            setOptionsJson(cleanedJson)
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Tab') {
                                e.preventDefault()
                                const text = e.currentTarget.value
                                const cursorPosition = e.currentTarget.selectionStart

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
                                    const startKey = quoteIndices[0]
                                    const endKey = quoteIndices[1]
                                    const startValue = quoteIndices[2]

                                    if (relCursor > startKey && relCursor <= endKey) {
                                        const newCursorPosition = lineStart + startValue + 1
                                        e.currentTarget.selectionStart = newCursorPosition
                                        e.currentTarget.selectionEnd = newCursorPosition
                                        return
                                    }
                                }

                                const newText =
                                    text.slice(0, cursorPosition) +
                                    '  ' +
                                    text.slice(cursorPosition)
                                // add 2 spaces
                                const newCursorPosition = cursorPosition + 2
                                setOptionsJson(newText)
                                e.currentTarget.value = newText
                                e.currentTarget.selectionStart = newCursorPosition
                                e.currentTarget.selectionEnd = newCursorPosition
                            }
                            if (e.key === '"') {
                                const text = e.currentTarget.value
                                const cursorPosition = e.currentTarget.selectionStart
                                // Check if there's already a closing quote immediately after cursor
                                const nextChar = text[cursorPosition]
                                if (nextChar !== '"') {
                                    e.preventDefault()
                                    const newText =
                                        text.slice(0, cursorPosition) +
                                        '""' +
                                        text.slice(cursorPosition)
                                    setOptionsJson(newText)
                                    e.currentTarget.value = newText
                                    // Position cursor between the quotes
                                    e.currentTarget.selectionStart = cursorPosition + 1
                                    e.currentTarget.selectionEnd = cursorPosition + 1
                                }
                            }
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                const text = e.currentTarget.value
                                const cursorPosition = e.currentTarget.selectionStart
                                const textBeforeCursor = text.slice(0, cursorPosition)
                                const textAfterCursor = text.slice(cursorPosition)

                                const trimmedBefore = textBeforeCursor.trimEnd()
                                const lastChar = trimmedBefore[trimmedBefore.length - 1]

                                // Don't add comma if we're after an opening brace/bracket or existing comma
                                const needsComma = lastChar && !['{', '[', ','].includes(lastChar)

                                let newText = textBeforeCursor
                                let moveCursor = 4

                                if (needsComma) {
                                    newText += ','
                                    moveCursor += 1
                                }

                                newText += '\n  "": ""'

                                if (textAfterCursor.startsWith('}')) {
                                    newText += '\n'
                                }

                                newText += textAfterCursor
                                const newCursorPosition = cursorPosition + moveCursor

                                setOptionsJson(newText)
                                e.currentTarget.value = newText
                                e.currentTarget.selectionStart = newCursorPosition
                                e.currentTarget.selectionEnd = newCursorPosition
                            }
                        }}
                        onScroll={(event) => {
                            setScrollTop(event.currentTarget.scrollTop)
                        }}
                        onClick={() => {
                            refreshTextareaLayout()
                        }}
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck="false"
                        isInvalid={!isJsonValid || !!optionsProblem}
                        errorMessage={isJsonValid ? optionsProblem : 'Invalid JSON'}
                        disableAutosize={true}
                        rows={12}
                        size="lg"
                        onClear={() => {
                            setOptionsJson(JSON.stringify({}, null, 2))
                        }}
                        endContent={
                            setIsLocked && (
                                <Tooltip
                                    content="Lock to prevent changes when switching paths"
                                    className="max-w-48"
                                    color="foreground"
                                >
                                    {isLocked ? (
                                        <LockKeyholeIcon
                                            className="size-3 !ring-0 !outline-none cursor-pointer"
                                            onClick={() => setIsLocked(false)}
                                        />
                                    ) : (
                                        <LockOpenIcon
                                            className="size-3 !ring-0 !outline-none cursor-pointer"
                                            onClick={() => setIsLocked(true)}
                                        />
                                    )}
                                </Tooltip>
                            )
                        }
                        data-focus-visible="false"
                    />

                    {shouldShowSelector && (
                        <div className="absolute inset-0 z-30 pointer-events-none">
                            <div
                                className="absolute flex gap-1 right-1"
                                style={{
                                    top: decorationTop,
                                }}
                            >
                                {activePresets.length > 0 && (
                                    <Dropdown
                                        isOpen={isSelectorOpen}
                                        onOpenChange={(open) => {
                                            setIsSelectorOpen(open)
                                            if (!open) {
                                                setActiveDecoration(null)
                                            }
                                        }}
                                        placement="left-start"
                                        shadow="none"
                                    >
                                        <DropdownTrigger>
                                            <button
                                                type="button"
                                                className={DECORATION_BUTTON}
                                                aria-label={`Select preset value for ${activeDecoration?.key}`}
                                            >
                                                <ChevronDownIcon className="size-3.5" />
                                            </button>
                                        </DropdownTrigger>
                                        <DropdownMenu
                                            aria-label={`Preset values for ${activeDecoration?.key}`}
                                            onAction={(key) => {
                                                if (!activeDecoration) {
                                                    return
                                                }

                                                const selectedPreset = activePresets[Number(key)]
                                                if (!selectedPreset) {
                                                    return
                                                }

                                                applyPresetValue(
                                                    selectedPreset.token,
                                                    activeDecoration
                                                )
                                                setIsSelectorOpen(false)
                                                setActiveDecoration(null)
                                            }}
                                        >
                                            {activePresets.map((preset, index) => (
                                                <DropdownItem key={String(index)}>
                                                    {preset.isDefault
                                                        ? `${preset.label} (default)`
                                                        : preset.label}
                                                </DropdownItem>
                                            ))}
                                        </DropdownMenu>
                                    </Dropdown>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex flex-row flex-wrap items-start content-start justify-start w-1/2 overflow-y-auto gap-x-2.5 gap-y-3 rounded-medium">
                    {availableOptions.map((option) => {
                        const alreadyAdded = isOptionAdded(option.Name)

                        return (
                            <Tooltip
                                key={option.Name}
                                delay={500}
                                content={
                                    <div className="flex flex-col w-full gap-1 overflow-y-auto max-w-52 max-h-80 overscroll-y-none">
                                        <p className="sticky top-0 font-mono font-bold truncate bg-foreground shrink-0">
                                            {option.Name}
                                        </p>
                                        <p>{option.Help}</p>
                                    </div>
                                }
                                closeDelay={0}
                                className="pt-1.5 max-w-52"
                                color="foreground"
                            >
                                <Chip
                                    isDisabled={!isJsonValid}
                                    variant={alreadyAdded ? 'flat' : 'solid'}
                                    color={alreadyAdded ? 'primary' : 'default'}
                                    onClick={() => {
                                        startTransition(() => {
                                            if (alreadyAdded) {
                                                const newOptions = {
                                                    ...options,
                                                }
                                                newOptions[option.Name] = undefined
                                                setOptionsJson(JSON.stringify(newOptions, null, 2))

                                                return
                                            }

                                            let value: unknown = ''

                                            const defaultGlobalValue =
                                                globalOptions[
                                                    option.FieldName as keyof typeof globalOptions
                                                ]
                                            const isUnsafeInteger =
                                                typeof defaultGlobalValue === 'number' &&
                                                Number.isInteger(defaultGlobalValue) &&
                                                !Number.isSafeInteger(defaultGlobalValue)

                                            if (
                                                defaultGlobalValue !== null &&
                                                defaultGlobalValue !== undefined &&
                                                !isUnsafeInteger
                                            ) {
                                                value = toOptionValue(
                                                    defaultGlobalValue,
                                                    option.Type
                                                )
                                            } else {
                                                value = toOptionValue(
                                                    option.DefaultStr,
                                                    option.Type
                                                )
                                            }

                                            const newOptions = {
                                                ...options,
                                                [option.Name]: value,
                                            }

                                            // rclone never runs the mapper without `metadata`, so
                                            // the two arrive together; taking it away again is what
                                            // `metadataOptionsProblem` catches. The flag on its own
                                            // is an empty value; the panel that appears with it is
                                            // where it gets one.
                                            if (option.Name === 'metadata_mapper') {
                                                newOptions.metadata = true
                                            }

                                            setOptionsJson(JSON.stringify(newOptions, null, 2))
                                        })
                                    }}
                                    classNames={{
                                        base: alreadyAdded
                                            ? 'border-primary border-1 text-primary-900'
                                            : undefined,
                                        content: 'cursor-pointer',
                                    }}
                                    size="sm"
                                    as={'button'}
                                >
                                    {option.Name}
                                </Chip>
                            </Tooltip>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
