import { Select, SelectItem } from '@heroui/react'
import { LockIcon } from 'lucide-react'
import type { ConfigFile } from '../../types/config'

/** Picker for the config file a scheduled task runs with (lock icon = encrypted config). */
export default function ConfigSelect({
    configFiles,
    value,
    onChange,
    label = 'Config file',
    placeholder,
}: {
    configFiles: ConfigFile[]
    value: string | null
    onChange: (id: string) => void
    label?: string
    placeholder?: string
}) {
    return (
        <Select
            label={label || undefined}
            aria-label={label ? undefined : 'Config file'}
            labelPlacement="outside"
            selectedKeys={value ? [value] : []}
            onSelectionChange={(keys) => {
                const id = Array.from(keys)[0]
                if (typeof id === 'string') {
                    onChange(id)
                }
            }}
            items={configFiles.filter((config) => !!config.id)}
            placeholder={placeholder ?? 'Select a config'}
        >
            {(config) => (
                <SelectItem
                    key={config.id!}
                    startContent={
                        config.isEncrypted ? (
                            <LockIcon className="w-3.5 h-3.5 text-warning" />
                        ) : undefined
                    }
                >
                    {config.label || config.id}
                </SelectItem>
            )}
        </Select>
    )
}

/** The scheduled runner cannot prompt for passwords — surface this before the task is saved. */
export function configPasswordMissing(configFiles: ConfigFile[], configId: string | null): boolean {
    const config = configFiles.find((c) => c.id === configId)
    return !!config?.isEncrypted && !config.pass && !config.passCommand
}
