import { Button, Input } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Eye as EyeIcon, EyeSlash as EyeSlashIcon } from '@zappicon/react'
import { useState } from 'react'
import type { Option } from '../../../lib/catalog'
import { formatErrorMessage } from '../../../lib/errors'
import { message } from '../../../lib/shell'
import { generateFilenApiKey } from './filenKey'

export default function FilenApiKeyField({
    option,
    config,
    savedPassword,
    setConfig,
    isDisabled = false,
    helpTitle,
    helpDescription,
}: {
    option: Option
    config: Record<string, any>
    savedPassword?: string
    setConfig: (config: Record<string, any>) => void
    isDisabled?: boolean
    helpTitle: string
    helpDescription: string
}) {
    const [isGenerating, setIsGenerating] = useState(false)
    const [isRevealed, setIsRevealed] = useState(false)

    const email = (config?.email ?? '').trim()
    const password = config?.password ?? ''
    const passwordObscured = !!savedPassword && password === savedPassword
    const canGenerate = Boolean(email && password) && !passwordObscured

    const handleGenerate = async () => {
        setIsGenerating(true)
        try {
            const apiKey = await generateFilenApiKey({ email, password })
            if (apiKey === null) return
            setConfig((prev: Record<string, any>) => ({ ...prev, [option.name]: apiKey }))
        } catch (e) {
            console.error('[FilenApiKeyField] failed to generate API key', e)
            await message(formatErrorMessage(e, t`Failed to generate API key`), {
                title: t`Could not generate API key`,
                kind: 'error',
            })
        } finally {
            setIsGenerating(false)
        }
    }

    return (
        <Input
            key={option.name}
            id={`field-${option.name}`}
            name={option.name}
            label={option.name}
            labelPlacement="outside"
            placeholder={helpTitle}
            type={option.password && !isRevealed ? 'password' : 'text'}
            classNames={{ 'inputWrapper': 'pr-0' }}
            value={config?.[option.name] ?? option.defaultText ?? ''}
            onValueChange={(value) => {
                setConfig((prev: Record<string, any>) => ({
                    ...prev,
                    [option.name]: value,
                }))
            }}
            endContent={
                <div className="flex items-center h-full gap-1">
                    {option.password && (
                        <button
                            type="button"
                            aria-label={isRevealed ? t`Hide value` : t`Reveal value`}
                            className="px-1 text-foreground-400 outline-hidden focus:outline-hidden"
                            onClick={() => setIsRevealed((prev) => !prev)}
                        >
                            {isRevealed ? (
                                <EyeSlashIcon className="size-4 shrink-0" />
                            ) : (
                                <EyeIcon className="size-4 shrink-0" />
                            )}
                        </button>
                    )}
                    <Button
                        size="sm"
                        className="h-full gap-1 rounded-l-none"
                        color="primary"
                        isLoading={isGenerating}
                        isDisabled={isDisabled || !canGenerate}
                        onPress={handleGenerate}
                    >
                        <Trans comment="Button: gets the Filen account's API key and fills it in.">
                            Generate
                        </Trans>
                    </Button>
                </div>
            }
            isRequired={option.required}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            description={
                canGenerate
                    ? helpDescription
                    : passwordObscured
                      ? t`Type your Filen password again above, then press Generate. The saved one is kept obscured.`
                      : t`Enter your Filen email and password above, then press Generate.`
            }
            isDisabled={isDisabled}
        />
    )
}
