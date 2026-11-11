import { Button, Input } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { startTransition, useEffect, useId, useState } from 'react'
import { formatErrorMessage, refusedFields } from '../../../lib/errors'
import { updateSettings, useSettings } from '../../../lib/settings'
import { toastSuccess } from '../../components/toast'
import { SettingRow } from './SettingsGroup'

/** The field that the core names when it refuses a limit. */
const FIELD = 'transfers.bw_limit'

/**
 * rclone's bandwidth limit (--bwlimit), for every transfer, mount and serve together. A change
 * applies at once, to what is running too.
 */
export default function BandwidthRow() {
    const inputId = useId()
    const { settings } = useSettings()
    const saved = settings?.transfers?.bwLimit ?? ''

    const [value, setValue] = useState('')
    const [problem, setProblem] = useState('')
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        startTransition(() => setValue(saved))
    }, [saved])

    const save = async (limit: string) => {
        setIsSaving(true)
        try {
            await updateSettings({ bwLimit: limit })
            setProblem('')
            // The limit is shown as rclone reads it (10M), in every language.
            const shown = limit.trim()
            setValue(shown)
            toastSuccess(shown ? t`Bandwidth limited to ${shown}` : t`Bandwidth limit removed`)
        } catch (error) {
            setProblem(refusedFields(error)[FIELD] ?? formatErrorMessage(error))
        } finally {
            setIsSaving(false)
        }
    }

    const changed = value.trim() !== saved

    return (
        <SettingRow
            stacked={true}
            title={t`Bandwidth limit`}
            titleId={inputId}
            description={t({
                message:
                    'How fast rclone may upload and download, for every transfer, mount and serve together. Use 10M for 10 MiB/s, or 10M:2M to upload at up to 10 MiB/s and download at up to 2 MiB/s. It applies at once.',
                comment:
                    "10M and 10M:2M are values in rclone's syntax, and MiB/s is its unit: keep them as they are.",
            })}
        >
            <div className="flex flex-row flex-wrap items-start gap-2">
                <Input
                    aria-labelledby={inputId}
                    placeholder={t`No limit`}
                    value={value}
                    onChange={(e) => {
                        setValue(e.target.value)
                        setProblem('')
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && changed && !isSaving) {
                            save(value)
                        }
                    }}
                    isInvalid={!!problem}
                    errorMessage={problem}
                    className="flex-1 min-w-60"
                    classNames={{ input: 'font-mono text-small' }}
                    data-focus-visible="false"
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                />
                <div className="flex flex-row gap-2">
                    <Button
                        color="primary"
                        // As wide as the proxy's "Test and save", so the two fields end together.
                        className="min-w-32"
                        onPress={() => save(value)}
                        isDisabled={!changed || isSaving}
                        isLoading={isSaving}
                        data-focus-visible="false"
                    >
                        <Trans>Save</Trans>
                    </Button>
                    {saved && (
                        <Button
                            color="danger"
                            variant="flat"
                            onPress={() => save('')}
                            isDisabled={isSaving}
                            data-focus-visible="false"
                        >
                            <Trans>Remove limit</Trans>
                        </Button>
                    )}
                </div>
            </div>
        </SettingRow>
    )
}
