import { Button, Input } from '@heroui/react'

import { FolderOpenIcon } from 'lucide-react'
import type { BackendOption } from '../../types/rclone'
import { pickPath } from '../../lib/api/dialog'

// The last path segment and its separator ("/token.json", "\\token.json").
const RE_LAST_SEGMENT = /[\\/][^\\/]*$/

// Standard string RemoteField for options that hold a local filesystem path (rclone has no explicit
// "path" flag, so callers opt fields in by name). Adds a button that opens the file/folder
// picker and fills the field with the chosen path; the field stays freely editable.
export default function PathPickerField({
    option,
    config,
    setConfig,
    isDisabled = false,
    helpTitle,
    helpDescription,
    directory = false,
}: {
    option: BackendOption
    config: Record<string, any>
    setConfig: (config: Record<string, any>) => void
    isDisabled?: boolean
    helpTitle: string
    helpDescription: string
    directory?: boolean
}) {
    const handleBrowse = async () => {
        try {
            // Start in the folder the field already points at: the value itself for a folder
            // option, the parent folder for a file option.
            const current: string = config?.[option.Name] ?? ''
            const parent = current.replace(RE_LAST_SEGMENT, '')
            const defaultPath = directory ? current : parent
            const selected = await pickPath({
                directory,
                multiple: false,
                title: directory ? 'Select folder' : 'Select file',
                defaultPath: defaultPath || undefined,
            })

            if (typeof selected !== 'string') {
                return
            }

            setConfig((prev: Record<string, any>) => ({ ...prev, [option.Name]: selected }))
        } catch (e) {
            console.error('[PathPickerField] selection failed', e)
        }
    }

    return (
        <Input
            key={option.Name}
            id={`field-${option.Name}`}
            name={option.Name}
            label={option.Name}
            labelPlacement="outside"
            placeholder={helpTitle}
            type="text"
            classNames={{ 'inputWrapper': 'pr-0' }}
            value={config?.[option.Name] ?? option.DefaultStr ?? ''}
            onValueChange={(value) => {
                setConfig((prev: Record<string, any>) => ({
                    ...prev,
                    [option.Name]: value,
                }))
            }}
            endContent={
                <Button
                    isIconOnly={true}
                    size="sm"
                    className="h-full rounded-l-none"
                    aria-label={directory ? 'Browse for folder' : 'Browse for file'}
                    isDisabled={isDisabled}
                    onPress={handleBrowse}
                >
                    <FolderOpenIcon className="size-4 shrink-0" />
                </Button>
            }
            isRequired={option.Required}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            description={helpDescription}
            isDisabled={isDisabled}
        />
    )
}
