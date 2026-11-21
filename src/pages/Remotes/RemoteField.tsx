import {
    Autocomplete,
    AutocompleteItem,
    Button,
    Checkbox,
    Input,
    Select,
    SelectItem,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowUpRightSquare as ArrowUpRightSquareIcon,
    Eye as EyeIcon,
    EyeSlash as EyeSlashIcon,
} from '@zappicon/react'
import { type Dispatch, type SetStateAction, useMemo, useState } from 'react'
import { Kind, type Option, Path } from '../../../lib/catalog'
import { foldCase } from '../../../lib/format'
import { OWN_OAUTH_TYPES } from '../../../lib/rclone/overrides'
import { openUrl } from '../../../lib/shell'
import FilenApiKeyField from './FilenApiKeyField'
import PathPickerField from './PathPickerField'

export type RemoteValues = Record<string, any>

function startsWithIgnoringCase(textValue: string, inputValue: string) {
    return foldCase(textValue).startsWith(foldCase(inputValue))
}

// The drawer's body scrolls, and a list that opens near its bottom would close on the first
// scroll, so the lists stay open while it scrolls.
const STAY_OPEN = { shouldCloseOnScroll: false }

const PICKS = {
    [Path.PathFile]: 'file',
    [Path.PathDir]: 'folder',
    [Path.PathRemote]: 'remote',
} as const

const LIST_HINT: Record<string, string> = {
    ',': t`Separate values with commas.`,
    ' ': t`Separate values with spaces.`,
}

const NO_VALUE = t({
    message: 'No Value',
    comment: "An empty choice in a list of an option's values.",
})

// The field for one backend option. The kind of input depends on the option's kind in the core's
// catalog:
// - a checkbox for bools
// - a select for a closed set of values (a Tristate, an enum, or rclone's Exclusive)
// - a multi-select for a set of flags (encodings, bit sets)
// - a number input for numbers
// - suggestions where rclone or the catalog offer values (sizes, durations, examples)
// - a text input for everything else
// Every value is sent back as text, and rclone parses it in the same way as its CLI wizard.
export default function RemoteField({
    option,
    config,
    saved,
    setConfig,
    isDisabled = false,
}: {
    option: Option
    config: RemoteValues
    /** When editing, the values that rclone stores. */
    saved?: RemoteValues
    setConfig: Dispatch<SetStateAction<RemoteValues>>
    isDisabled?: boolean
}) {
    const fieldId = `field-${option.name}`
    const initialFieldValue = useMemo<string>(
        () => config?.[option.name]?.toString() || option.defaultText,
        [config, option.name, option.defaultText]
    )
    const helpTitle = useMemo(() => option.help.split('\n')[0], [option.help])
    const helpDescription = useMemo(
        () => option.help.split('\n').slice(1).join('\n'),
        [option.help]
    )
    const choices = option.choices

    const [isRevealed, setIsRevealed] = useState(false)

    const set = (value: string) =>
        setConfig((prev: RemoteValues) => ({ ...prev, [option.name]: value }))

    if (option.hidden) return null

    // Filen's api_key can be generated from the account's email and password, as the
    // `filen export-api-key` CLI command does, so it gets a "Generate" button.
    if (config?.type === 'filen' && option.name === 'api_key') {
        return (
            <FilenApiKeyField
                option={option}
                config={config}
                savedPassword={saved?.password}
                setConfig={setConfig}
                isDisabled={isDisabled}
                helpTitle={helpTitle}
                helpDescription={helpDescription}
            />
        )
    }

    if (option.path !== Path.PathUnspecified) {
        return (
            <PathPickerField
                option={option}
                config={config}
                setConfig={setConfig}
                isDisabled={isDisabled}
                helpTitle={helpTitle}
                helpDescription={helpDescription}
                picks={PICKS[option.path]}
            />
        )
    }

    if (option.kind === Kind.KindBool) {
        return (
            <div className="flex flex-col gap-0.5">
                <Checkbox
                    defaultSelected={initialFieldValue === 'true'}
                    name={option.name}
                    radius="sm"
                    onValueChange={(value) => set(String(value))}
                    isDisabled={isDisabled}
                >
                    {option.name}
                </Checkbox>
                {helpDescription && (
                    <p className="text-xs text-foreground-400">{helpDescription}</p>
                )}
            </div>
        )
    }

    // A set of flags. Any number of them can be picked, and they are written comma-separated.
    if (option.kind === Kind.KindFlags) {
        const selected = initialFieldValue
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v && v !== 'off' && v !== 'None')
        return (
            <Select
                id={fieldId}
                name={option.name}
                label={option.name}
                // "outside" positions the label from the field's bottom, so a long description
                // would push the label onto it. "outside-top" keeps the label in the flow.
                labelPlacement="outside-top"
                placeholder={helpTitle}
                description={helpDescription}
                isDisabled={isDisabled}
                selectionMode="multiple"
                popoverProps={STAY_OPEN}
                defaultSelectedKeys={selected}
                onSelectionChange={(keys) => set(Array.from(keys).map(String).join(','))}
            >
                {choices.map((item) => (
                    <SelectItem key={item.value} textValue={item.value}>
                        {item.value} {item.help && `— ${item.help}`}
                    </SelectItem>
                ))}
            </Select>
        )
    }

    // A closed set of values uses a Select, so there is no text to mistype.
    if (
        option.kind === Kind.KindChoice ||
        option.kind === Kind.KindTristate ||
        (option.exclusive && choices.length > 0)
    ) {
        return (
            <Select
                id={fieldId}
                name={option.name}
                label={option.name}
                // "outside-top" for the same reason as the flags Select above.
                labelPlacement="outside-top"
                placeholder={helpTitle}
                description={helpDescription}
                isDisabled={isDisabled}
                isRequired={option.required}
                disallowEmptySelection={true}
                popoverProps={STAY_OPEN}
                defaultSelectedKeys={initialFieldValue ? [initialFieldValue] : []}
                onSelectionChange={(keys) => {
                    const value = Array.from(keys)[0]
                    if (value !== undefined) set(String(value))
                }}
            >
                {choices.map((item) => (
                    <SelectItem key={item.value} textValue={item.value}>
                        {item.value || NO_VALUE} {item.help && `— ${item.help}`}
                    </SelectItem>
                ))}
            </Select>
        )
    }

    if (choices.length > 0) {
        // The wrapper catches Tab in the capture phase, before react-aria's own key handler, so
        // Tab doesn't replace the typed text with the highlighted item.
        return (
            <div
                onKeyDownCapture={(event) => {
                    if (event.key === 'Tab') event.stopPropagation()
                }}
            >
                <Autocomplete
                    id={fieldId}
                    name={option.name}
                    defaultInputValue={initialFieldValue}
                    defaultItems={choices}
                    label={option.name}
                    labelPlacement="outside"
                    placeholder={helpTitle}
                    description={helpDescription}
                    isDisabled={isDisabled}
                    isRequired={option.required}
                    allowsCustomValue={true}
                    popoverProps={STAY_OPEN}
                    // The list opens while typing and matches by prefix, so a typed value is never
                    // replaced by a similar item (`6M` must not complete to `16M`).
                    menuTrigger="input"
                    defaultFilter={startsWithIgnoringCase}
                    onSelectionChange={(value) => {
                        if (value !== null) set(String(value))
                    }}
                    onInputChange={set}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck="false"
                >
                    {(item) => (
                        <AutocompleteItem
                            key={item.value}
                            textValue={item.value}
                            startContent={
                                option.name === 'provider' && (
                                    <img
                                        src={`/icons/providers/${item.value}.png`}
                                        className="object-contain w-4 h-4"
                                        alt={item.value}
                                        onError={(e) => {
                                            e.currentTarget.src = '/icon.png'
                                            e.currentTarget.className += ' invert dark:invert-0'
                                            e.currentTarget.onerror = null
                                        }}
                                    />
                                )
                            }
                        >
                            {item.value || NO_VALUE} {item.help && `— ${item.help}`}
                        </AutocompleteItem>
                    )}
                </Autocomplete>
            </div>
        )
    }

    const requiresOwnCredentials =
        OWN_OAUTH_TYPES.includes(config?.type) &&
        (option.name === 'client_id' || option.name === 'client_secret')

    const isNumber = option.kind === Kind.KindInt || option.kind === Kind.KindFloat
    const inputType = isNumber ? 'number' : option.password && !isRevealed ? 'password' : 'text'

    // The guide button takes priority over the reveal toggle when both could apply.
    const endContent = requiresOwnCredentials ? (
        <Button
            size="sm"
            className="h-full gap-1 rounded-l-none"
            color="warning"
            endContent={<ArrowUpRightSquareIcon className="mb-0.5 size-4 shrink-0" />}
            onPress={() => {
                openUrl(
                    `https://rclone.org/${config?.type === 'google photos' ? 'googlephotos' : 'drive'}/#making-your-own-client-id`
                )
            }}
        >
            <Trans comment="Button: opens rclone's guide to making your own client ID.">
                Guide
            </Trans>
        </Button>
    ) : option.password ? (
        <button
            type="button"
            aria-label={isRevealed ? t`Hide value` : t`Reveal value`}
            className="outline-hidden text-foreground-400 focus:outline-hidden"
            onClick={() => setIsRevealed((prev) => !prev)}
        >
            {isRevealed ? (
                <EyeSlashIcon className="size-4 shrink-0" />
            ) : (
                <EyeIcon className="size-4 shrink-0" />
            )}
        </button>
    ) : undefined

    const listHint = option.kind === Kind.KindList ? LIST_HINT[option.separator] : undefined
    const description = requiresOwnCredentials
        ? undefined
        : [helpDescription, listHint].filter(Boolean).join('\n')

    return (
        <Input
            key={option.name}
            id={fieldId}
            name={option.name}
            label={option.name}
            labelPlacement="outside"
            placeholder={helpTitle}
            type={inputType}
            inputMode={isNumber ? 'decimal' : undefined}
            classNames={
                requiresOwnCredentials
                    ? {
                          description: 'text-warning',
                          'inputWrapper': 'pr-0',
                      }
                    : undefined
            }
            onValueChange={set}
            endContent={endContent}
            isRequired={option.required || requiresOwnCredentials}
            defaultValue={initialFieldValue}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            description={description}
            isDisabled={isDisabled}
        />
    )
}
