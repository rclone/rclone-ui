import {
    Autocomplete,
    AutocompleteItem,
    Button,
    Checkbox,
    Input,
    Select,
    SelectItem,
} from '@heroui/react'

import { ExternalLinkIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { optionChoices, optionDefaultText, optionKind } from '@/lib/rclone/optionTypes'
import { OWN_OAUTH_TYPES, REMOTE_WRAPPER_TYPES } from '@/lib/rclone/overrides'
import type { BackendOption } from '@/lib/rclone/types'
import FilenApiKeyField from './FilenApiKeyField'
import PickerField from './PickerField'
import { openUrl } from '@/navigate'

// rclone has no "is a local path" flag, so opt fields in by name. Value = whether it's a directory.
const PATH_PICKER_FIELDS: Record<string, { directory: boolean }> = {
    service_account_file: { directory: false }, // drive, google cloud storage
    box_config_file: { directory: false }, // box
    client_certificate_path: { directory: false }, // azureblob, azurefiles
    service_principal_file: { directory: false }, // azureblob, azurefiles
    config_file: { directory: false }, // oracleobjectstorage
    sse_customer_key_file: { directory: false }, // oracleobjectstorage
    shared_credentials_file: { directory: false }, // s3
    key_file: { directory: false }, // sftp
    known_hosts_file: { directory: false }, // sftp
    pubkey_file: { directory: false }, // sftp
    kerberos_ccache: { directory: false }, // smb
    unix_socket: { directory: false }, // webdav
    chunk_path: { directory: true }, // cache
    db_path: { directory: true }, // cache
    tmp_upload_path: { directory: true }, // cache
}

function startsWithIgnoringCase(textValue: string, inputValue: string) {
    return textValue.toLowerCase().startsWith(inputValue.toLowerCase())
}

// One field per backend option. The widget follows the option's rclone `Type` through
// lib/rclone/optionTypes: a checkbox for bools, a suggestion list where rclone or the shared
// presets offer values, a number input for numeric types, and a text input for everything else
// (lists, sizes without examples, encodings, times, …). Every value is sent back as text; rclone
// parses it like the CLI wizard does.
export default function RemoteField({
    option,
    config,
    setConfig,
    isDisabled = false,
}: {
    option: BackendOption
    config: Record<string, any>
    setConfig: (config: Record<string, any>) => void
    isDisabled?: boolean
}) {
    // For S3 type, only show fields that match the current provider or have no provider specified
    // if (config.type === 's3' && option.Provider && option.Provider !== config.provider) {
    //     return null
    // }

    const fieldId = useMemo(() => `field-${option.Name}`, [option.Name])
    const initialFieldValue = useMemo(
        () => config?.[option.Name]?.toString() || optionDefaultText(option),
        [config, option]
    )
    const helpTitle = useMemo(() => option.Help.split('\n')[0], [option.Help])
    const helpDetails = useMemo(() => option.Help.split('\n').slice(1), [option.Help])
    const helpDescription = useMemo(() => helpDetails.join('\n'), [helpDetails])
    const choices = useMemo(() => optionChoices(option), [option])

    // Password fields (rclone `IsPassword`) render obscured; this toggles a plaintext reveal.
    const [isRevealed, setIsRevealed] = useState(false)

    if (option.Hide !== 0) return null

    // Filen's api_key can be generated from the account's email + password (mirrors the
    // `filen export-api-key` CLI command), so render it with an inline "Generate" button.
    if (config?.type === 'filen' && option.Name === 'api_key') {
        return (
            <FilenApiKeyField
                option={option}
                config={config}
                setConfig={setConfig}
                isDisabled={isDisabled}
                helpTitle={helpTitle}
                helpDescription={helpDescription}
            />
        )
    }

    // A wrapper backend's `remote` (the remote it wraps) is picked from the file panel.
    if (option.Name === 'remote' && REMOTE_WRAPPER_TYPES.includes(config?.type)) {
        return (
            <PickerField
                option={option}
                config={config}
                setConfig={setConfig}
                isDisabled={isDisabled}
                helpTitle={helpTitle}
                helpDescription={helpDescription}
                picks="remote"
            />
        )
    }

    // Local-path options (service account files, certs, cache dirs, …) get a path picker.
    const pathPicker = PATH_PICKER_FIELDS[option.Name]
    if (pathPicker) {
        return (
            <PickerField
                option={option}
                config={config}
                setConfig={setConfig}
                isDisabled={isDisabled}
                helpTitle={helpTitle}
                helpDescription={helpDescription}
                picks={pathPicker.directory ? 'folder' : 'file'}
            />
        )
    }

    const kind = optionKind(option)

    if (kind === 'bool') {
        return (
            <div className="flex flex-col gap-0.5">
                <Checkbox
                    defaultSelected={initialFieldValue === 'true'}
                    name={option.Name}
                    radius="sm"
                    onValueChange={(value) => {
                        setConfig((prev: Record<string, any>) => ({
                            ...prev,
                            [option.Name]: value,
                        }))
                    }}
                    isDisabled={isDisabled}
                >
                    {option.Name}
                </Checkbox>
                {helpDetails.length > 0 && (
                    <p className="text-xs text-foreground-400">{helpDescription}</p>
                )}
            </div>
        )
    }

    // A closed list (Tristate, `a|b|c` enum, rclone `Exclusive`) is a Select: fixed values, no
    // text to mistype. An open list is an autocomplete that keeps whatever the user types.
    if (choices?.exclusive) {
        return (
            <Select
                id={fieldId}
                name={option.Name}
                label={option.Name}
                labelPlacement="outside"
                placeholder={helpTitle}
                description={helpDescription}
                isDisabled={isDisabled}
                isRequired={option.Required}
                disallowEmptySelection={true}
                defaultSelectedKeys={initialFieldValue ? [initialFieldValue] : []}
                onSelectionChange={(keys) => {
                    const value = Array.from(keys)[0]
                    if (value === undefined) return
                    setConfig((prev: Record<string, any>) => ({
                        ...prev,
                        [option.Name]: String(value),
                    }))
                }}
            >
                {choices.values.map((item) => (
                    <SelectItem key={item.Value} textValue={item.Value}>
                        {item.Value || 'No Value'} {item.Help && `— ${item.Help}`}
                    </SelectItem>
                ))}
            </Select>
        )
    }

    // An "Other" S3 provider has no meaningful endpoint suggestions.
    const shouldUseAutocomplete =
        !!choices && !(config?.provider === 'Other' && option.Name === 'endpoint')

    if (shouldUseAutocomplete) {
        // The wrapper sees Tab before react-aria's own key handler (capture phase) and keeps it
        // from committing the highlighted item over the typed text. HeroUI's `inputProps` does
        // not forward capture handlers.
        return (
            <div
                onKeyDownCapture={(event) => {
                    if (event.key === 'Tab') event.stopPropagation()
                }}
            >
                <Autocomplete
                    id={fieldId}
                    name={option.Name}
                    defaultInputValue={initialFieldValue}
                    defaultItems={choices.values}
                    label={option.Name}
                    labelPlacement="outside"
                    placeholder={helpTitle}
                    description={helpDescription}
                    isDisabled={isDisabled}
                    isRequired={option.Required}
                    allowsCustomValue={true}
                    // The list opens while typing and matches by prefix, so a typed value is never
                    // swallowed by a look-alike item (`6M` must not complete to `16M`), and merely
                    // tabbing through a field never opens the list. Enter picks the highlighted item;
                    // Tab leaves the typed text alone (react-aria would commit the highlight).
                    menuTrigger="input"
                    defaultFilter={startsWithIgnoringCase}
                    onSelectionChange={(value) => {
                        setConfig((prev: Record<string, any>) => ({
                            ...prev,
                            [option.Name]: value,
                        }))
                    }}
                    onInputChange={(value) => {
                        setConfig((prev: Record<string, any>) => ({
                            ...prev,
                            [option.Name]: value,
                        }))
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck="false"
                >
                    {(item) => (
                        <AutocompleteItem
                            key={item.Value}
                            textValue={item.Value}
                            startContent={
                                option.Name === 'provider' && (
                                    <img
                                        src={`/icons/providers/${item.Value}.png`}
                                        className="object-contain w-4 h-4"
                                        alt={item.Value}
                                        onError={(e) => {
                                            e.currentTarget.src = '/icon.png'
                                            e.currentTarget.className += ' invert dark:invert-0'
                                            e.currentTarget.onerror = null
                                        }}
                                    />
                                )
                            }
                        >
                            {item.Value || 'No Value'} {item.Help && `— ${item.Help}`}
                        </AutocompleteItem>
                    )}
                </Autocomplete>
            </div>
        )
    }

    const requiresOwnCredentials =
        OWN_OAUTH_TYPES.includes(config?.type) &&
        (option.Name === 'client_id' || option.Name === 'client_secret')

    const inputType =
        kind === 'number' ? 'number' : option.IsPassword && !isRevealed ? 'password' : 'text'

    // GUIDE button takes priority over the reveal toggle when both could apply.
    const endContent = requiresOwnCredentials ? (
        <Button
            size="sm"
            className="h-full gap-1 rounded-l-none"
            color="warning"
            endContent={<ExternalLinkIcon className="mb-0.5 size-4 shrink-0" />}
            onPress={() => {
                openUrl(
                    `https://rclone.org/${config?.type === 'google photos' ? 'googlephotos' : 'drive'}/#making-your-own-client-id`
                )
            }}
        >
            GUIDE
        </Button>
    ) : option.IsPassword ? (
        <button
            type="button"
            aria-label={isRevealed ? 'Hide value' : 'Reveal value'}
            className="text-foreground-400 outline-none focus:outline-none"
            onClick={() => setIsRevealed((prev) => !prev)}
        >
            {isRevealed ? (
                <EyeOffIcon className="size-4 shrink-0" />
            ) : (
                <EyeIcon className="size-4 shrink-0" />
            )}
        </button>
    ) : undefined

    return (
        <Input
            key={option.Name}
            id={fieldId}
            name={option.Name}
            label={option.Name}
            labelPlacement="outside"
            placeholder={helpTitle}
            type={inputType}
            inputMode={kind === 'number' ? 'decimal' : undefined}
            classNames={
                requiresOwnCredentials
                    ? {
                          description: 'text-warning',
                          'inputWrapper': 'pr-0',
                      }
                    : undefined
            }
            onValueChange={(value) => {
                setConfig((prev: Record<string, any>) => ({
                    ...prev,
                    [option.Name]: value,
                }))
            }}
            endContent={endContent}
            isRequired={option.Required || requiresOwnCredentials}
            defaultValue={initialFieldValue}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            description={requiresOwnCredentials ? undefined : helpDescription}
            isDisabled={isDisabled}
        />
    )
}
