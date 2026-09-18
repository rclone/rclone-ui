import { Select, SelectItem } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'

import { FolderOpenIcon } from 'lucide-react'
import { useMemo } from 'react'
import { formatErrorMessage } from '../../lib/errors'
import { probeRcloneBinaryOrThrow } from '../../lib/rclone/common'
import { listDownloadedVersions } from '../../lib/rclone/versions'
import { pickPath } from '../../lib/api/dialog'

export const APP_DEFAULT_BINARY = 'app-default'
const CUSTOM_BINARY = 'custom'

/**
 * Picker for the rclone binary a scheduled task runs with: "App default", any downloaded
 * managed version, or a custom path (probed before acceptance).
 */
export default function BinarySelect({
    value,
    onChange,
    onError,
    label = 'rclone binary',
}: {
    value: string
    onChange: (path: string) => void
    onError?: (message: string) => void
    label?: string
}) {
    const versionsQuery = useQuery({
        queryKey: ['rclone', 'downloaded-versions'],
        queryFn: listDownloadedVersions,
    })

    const knownBinaryPaths = useMemo(
        () => (versionsQuery.data ?? []).map((version) => version.path),
        [versionsQuery.data]
    )
    const isCustomBinary = value !== APP_DEFAULT_BINARY && !knownBinaryPaths.includes(value)

    const binaryOptions = useMemo(
        () => [
            { key: APP_DEFAULT_BINARY, label: 'App default', description: undefined },
            ...(versionsQuery.data ?? []).map((version) => ({
                key: version.path,
                label: `v${version.version}`,
                description: version.path,
            })),
            {
                key: CUSTOM_BINARY,
                label: isCustomBinary ? 'Custom binary' : 'Custom…',
                description: isCustomBinary ? value : undefined,
            },
        ],
        [versionsQuery.data, isCustomBinary, value]
    )

    const pickCustomBinary = async () => {
        const selected = await pickPath({
            title: 'Select rclone binary',
            multiple: false,
            directory: false,
        })
        if (!selected) {
            return
        }
        try {
            await probeRcloneBinaryOrThrow(selected)
        } catch (error) {
            onError?.(formatErrorMessage(error, 'The selected file is not a valid rclone binary'))
            return
        }
        onChange(selected)
    }

    return (
        <Select
            label={label || undefined}
            aria-label={label ? undefined : 'rclone binary'}
            labelPlacement="outside"
            selectedKeys={[isCustomBinary ? CUSTOM_BINARY : value]}
            onSelectionChange={(keys) => {
                const key = Array.from(keys)[0]
                if (key === CUSTOM_BINARY) {
                    pickCustomBinary()
                } else if (typeof key === 'string' && key) {
                    onChange(key)
                }
            }}
            items={binaryOptions}
        >
            {(option) => (
                <SelectItem
                    key={option.key}
                    description={option.description}
                    startContent={
                        option.key === CUSTOM_BINARY ? (
                            <FolderOpenIcon className="w-3.5 h-3.5" />
                        ) : undefined
                    }
                >
                    {option.label}
                </SelectItem>
            )}
        </Select>
    )
}
