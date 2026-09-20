import { Button, Input } from '@heroui/react'

import { FolderOpenIcon } from 'lucide-react'
import { useState } from 'react'
import PathSelector from '@/components/PathSelector'
import { pickPath } from '@/dialog'
import { toWrappedRemote } from '@/lib/format'
import type { BackendOption } from '@/lib/rclone/types'

// The last path segment and its separator ("/token.json", "\\token.json").
const RE_LAST_SEGMENT = /[\\/][^\\/]*$/

const BROWSE_LABEL = {
    file: 'Browse for file',
    folder: 'Browse for folder',
    remote: 'Pick a remote or folder',
}

// The field for an option that names a place, with a button that picks one; the field stays
// freely editable. A `file` or `folder` is on the server's disk (rclone has no explicit "path"
// flag, so callers opt fields in by name). A `remote` is the `remote` option of a wrapper backend
// (alias, crypt, chunker, …): another remote or a local folder, plus a path, picked from the
// file panel over every remote and the local disk instead of typed as `remote:path`.
export default function PickerField({
    option,
    config,
    setConfig,
    isDisabled = false,
    helpTitle,
    helpDescription,
    picks,
}: {
    option: BackendOption
    config: Record<string, any>
    setConfig: (config: Record<string, any>) => void
    isDisabled?: boolean
    helpTitle: string
    helpDescription: string
    picks: 'file' | 'folder' | 'remote'
}) {
    const [isPickerOpen, setIsPickerOpen] = useState(false)
    const value: string = config?.[option.Name] ?? option.DefaultStr ?? ''
    const set = (next: string) =>
        setConfig((prev: Record<string, any>) => ({ ...prev, [option.Name]: next }))

    const browse = async () => {
        if (picks === 'remote') {
            setIsPickerOpen(true)
            return
        }
        try {
            // Start in the folder the field already points at: the value itself for a folder
            // option, the parent folder for a file option.
            const directory = picks === 'folder'
            const current: string = config?.[option.Name] ?? ''
            const defaultPath = directory ? current : current.replace(RE_LAST_SEGMENT, '')
            const selected = await pickPath({
                directory,
                multiple: false,
                title: directory ? 'Select folder' : 'Select file',
                defaultPath: defaultPath || undefined,
            })
            if (typeof selected === 'string') set(selected)
        } catch (e) {
            console.error('[PickerField] selection failed', e)
        }
    }

    return (
        <>
            <Input
                key={option.Name}
                id={`field-${option.Name}`}
                name={option.Name}
                label={option.Name}
                labelPlacement="outside"
                placeholder={helpTitle}
                type="text"
                classNames={{ 'inputWrapper': 'pr-0' }}
                value={value}
                onValueChange={set}
                endContent={
                    <Button
                        isIconOnly={true}
                        size="sm"
                        className="h-full rounded-l-none"
                        aria-label={BROWSE_LABEL[picks]}
                        isDisabled={isDisabled}
                        onPress={browse}
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
            {picks === 'remote' && (
                <PathSelector
                    isOpen={isPickerOpen}
                    onClose={() => setIsPickerOpen(false)}
                    onSelect={(items) => {
                        setIsPickerOpen(false)
                        const picked = items[0]
                        if (picked) set(toWrappedRemote(picked.path))
                    }}
                    initialPaths={value ? [value] : []}
                    // Roots and remotes only: a wrapped remote is rarely someone's Downloads folder.
                    allowedKeys={['REMOTES', 'LOCAL_FS', 'FAVORITES']}
                    mode="folders"
                    allowMultiple={false}
                />
            )}
        </>
    )
}
