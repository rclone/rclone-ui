import { Button, Input } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Folder as FolderIcon } from '@zappicon/react'
import { useState } from 'react'
import type { Option } from '../../../lib/catalog'
import { pickerStart, toWrappedRemote } from '../../../lib/paths'
import { open } from '../../../lib/shell'
import PathSelector from '../../components/PathSelector'

const BROWSE_LABEL = {
    file: t`Browse for file`,
    folder: t`Browse for folder`,
    remote: t`Pick a remote or folder`,
}

// A text RemoteField with a browse button, for options that hold a path. rclone doesn't mark these
// options, so the core's catalog lists them and sets `option.path`.
// - `file` and `folder` are local paths, picked in the native dialog.
// - `remote` is the `remote` option of a backend that wraps another (alias, crypt, …). It is
//   picked in the file panel, as `remote:path` or a local folder.
export default function PathPickerField({
    option,
    config,
    setConfig,
    isDisabled = false,
    helpTitle,
    helpDescription,
    picks,
}: {
    option: Option
    config: Record<string, any>
    setConfig: (config: Record<string, any>) => void
    isDisabled?: boolean
    helpTitle: string
    helpDescription: string
    picks: 'file' | 'folder' | 'remote'
}) {
    const [isPickerOpen, setIsPickerOpen] = useState(false)
    const value: string = config?.[option.name] ?? option.defaultText ?? ''
    const set = (next: string) =>
        setConfig((prev: Record<string, any>) => ({ ...prev, [option.name]: next }))

    const handleBrowse = async () => {
        if (picks === 'remote') {
            setIsPickerOpen(true)
            return
        }
        try {
            const directory = picks === 'folder'
            const selected = await open({
                directory,
                multiple: false,
                title: directory ? t`Select folder` : t`Select file`,
                defaultPath: pickerStart(config?.[option.name], directory),
            })
            if (typeof selected === 'string') set(selected)
        } catch (e) {
            console.error('[PathPickerField] selection failed', e)
        }
    }

    return (
        <>
            <Input
                key={option.name}
                id={`field-${option.name}`}
                name={option.name}
                label={option.name}
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
                        title={BROWSE_LABEL[picks]}
                        isDisabled={isDisabled}
                        onPress={handleBrowse}
                    >
                        <FolderIcon className="size-4 shrink-0" />
                    </Button>
                }
                isRequired={option.required}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck="false"
                description={helpDescription}
                isDisabled={isDisabled}
            />
            {picks === 'remote' && isPickerOpen && (
                <PathSelector
                    isOpen={isPickerOpen}
                    onClose={() => setIsPickerOpen(false)}
                    onSelect={(items) => {
                        setIsPickerOpen(false)
                        const picked = items[0]
                        if (picked) set(toWrappedRemote(picked.path))
                    }}
                    initialPaths={value ? [value] : []}
                    allowedKeys={['REMOTES', 'LOCAL_FS', 'FAVORITES']}
                    mode="folders"
                    allowMultiple={false}
                />
            )}
        </>
    )
}
