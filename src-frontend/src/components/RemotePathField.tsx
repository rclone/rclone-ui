import { Button, Input } from '@heroui/react'

import { FolderOpenIcon } from 'lucide-react'
import { useState } from 'react'
import { toWrappedRemote } from '../../lib/format'
import type { BackendOption } from '../../types/rclone'
import PathSelector from './PathSelector'

// The `remote` option of a wrapper backend (alias, crypt, chunker, …) names another remote, or a
// local folder, plus a path. Instead of typing `remote:path` by hand, the button opens the file
// panel over every remote and the local disk; the field stays freely editable.
export default function RemotePathField({
    option,
    config,
    setConfig,
    isDisabled = false,
    helpTitle,
    helpDescription,
}: {
    option: BackendOption
    config: Record<string, any>
    setConfig: (config: Record<string, any>) => void
    isDisabled?: boolean
    helpTitle: string
    helpDescription: string
}) {
    const [isPickerOpen, setIsPickerOpen] = useState(false)
    const value: string = config?.[option.Name] ?? option.DefaultStr ?? ''

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
                onValueChange={(next) => {
                    setConfig((prev: Record<string, any>) => ({ ...prev, [option.Name]: next }))
                }}
                endContent={
                    <Button
                        isIconOnly={true}
                        size="sm"
                        className="h-full rounded-l-none"
                        aria-label="Pick a remote or folder"
                        isDisabled={isDisabled}
                        onPress={() => setIsPickerOpen(true)}
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
            <PathSelector
                isOpen={isPickerOpen}
                onClose={() => setIsPickerOpen(false)}
                onSelect={(items) => {
                    setIsPickerOpen(false)
                    const picked = items[0]
                    if (!picked) return
                    const next = toWrappedRemote(picked.path)
                    setConfig((prev: Record<string, any>) => ({ ...prev, [option.Name]: next }))
                }}
                initialPaths={value ? [value] : []}
                // Roots and remotes only: a wrapped remote is rarely someone's Downloads folder.
                allowedKeys={['REMOTES', 'LOCAL_FS', 'FAVORITES']}
                mode="folders"
                allowMultiple={false}
            />
        </>
    )
}
