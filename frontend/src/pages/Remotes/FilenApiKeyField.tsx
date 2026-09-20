import { Button, Input } from '@heroui/react'

import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { useState } from 'react'
import type { BackendOption } from '@/lib/rclone/types'
import { message } from '@/dialog'
import { filenGateway } from '@/server/app'

function toHex(buffer: ArrayBuffer): string {
    let hex = ''
    for (const byte of new Uint8Array(buffer)) {
        hex += byte.toString(16).padStart(2, '0')
    }
    return hex
}

async function sha512Hex(input: string): Promise<string> {
    return toHex(await crypto.subtle.digest('SHA-512', new TextEncoder().encode(input)))
}

// POST to the Filen gateway, then unwrap its { status, message, code, data } envelope. The
// gateway has no CORS headers, so the server posts for the page (`filen_gateway`), with the
// anonymous bearer auth and body checksum @filen/sdk's APIClient sends.
async function filenPost<T>(endpoint: string, data: Record<string, unknown>): Promise<T> {
    const reply = await filenGateway(endpoint, data)
    if (reply.status < 200 || reply.status >= 300) {
        throw new Error(`Filen request failed (${reply.status})`)
    }

    const json = JSON.parse(reply.body) as {
        status?: boolean
        code?: string
        message?: string
        data?: T
    }

    if (json.status === false) {
        throw new Error(json.message || json.code || 'Filen rejected the request')
    }

    return json.data as T
}

// Reproduces `filen export-api-key` over raw HTTP: derive the login hash from the plaintext password
// (mirroring @filen/sdk's generatePasswordAndMasterKeyBasedOnAuthVersion), log in, return the apiKey.
export async function generateFilenApiKey({
    email,
    password,
}: {
    email: string
    password: string
}): Promise<string> {
    const authInfo = await filenPost<{ authVersion: number; salt: string }>('/v3/auth/info', {
        email,
    })

    if (authInfo.authVersion !== 2) {
        // v1 is deprecated; v3 uses Argon2id, which WebCrypto can't derive.
        throw new Error(
            `Unsupported Filen auth version (${authInfo.authVersion}). Run \`filen export-api-key\` and paste the key instead.`
        )
    }

    // PBKDF2-HMAC-SHA512, 200k iterations, 512-bit output. The second half of the derived key is
    // hashed once more with SHA-512 to form the login password (the first half is the master key).
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    )
    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: new TextEncoder().encode(authInfo.salt),
            iterations: 200000,
            hash: 'SHA-512',
        },
        keyMaterial,
        512
    )
    const derivedKey = toHex(derivedBits)
    const derivedPassword = await sha512Hex(derivedKey.slice(derivedKey.length / 2))

    const login = await filenPost<{ apiKey: string }>('/v3/login', {
        email,
        password: derivedPassword,
        twoFactorCode: 'XXXXXX',
        authVersion: authInfo.authVersion,
    })

    if (!login.apiKey) {
        throw new Error('Filen did not return an API key')
    }

    return login.apiKey
}

// Controlled variant of the standard string RemoteField, with a "Generate" button that logs in with
// the email/password already entered in the form and fills the field with the resulting API key.
export default function FilenApiKeyField({
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
    const [isGenerating, setIsGenerating] = useState(false)
    const [isRevealed, setIsRevealed] = useState(false)

    const email = (config?.email ?? '').trim()
    const password = config?.password ?? ''
    const canGenerate = Boolean(email && password)

    const handleGenerate = async () => {
        setIsGenerating(true)
        try {
            const apiKey = await generateFilenApiKey({ email, password })
            setConfig((prev: Record<string, any>) => ({ ...prev, [option.Name]: apiKey }))
        } catch (e) {
            console.error('[FilenApiKeyField] failed to generate API key', e)
            await message(e instanceof Error ? e.message : 'Failed to generate API key', {
                title: 'Could not generate API key',
                kind: 'error',
            })
        } finally {
            setIsGenerating(false)
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
            type={option.IsPassword && !isRevealed ? 'password' : 'text'}
            classNames={{ 'inputWrapper': 'pr-0' }}
            value={config?.[option.Name] ?? option.DefaultStr ?? ''}
            onValueChange={(value) => {
                setConfig((prev: Record<string, any>) => ({
                    ...prev,
                    [option.Name]: value,
                }))
            }}
            endContent={
                <div className="flex items-center h-full gap-1">
                    {option.IsPassword && (
                        <button
                            type="button"
                            aria-label={isRevealed ? 'Hide value' : 'Reveal value'}
                            className="px-1 text-foreground-400 outline-none focus:outline-none"
                            onClick={() => setIsRevealed((prev) => !prev)}
                        >
                            {isRevealed ? (
                                <EyeOffIcon className="size-4 shrink-0" />
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
                        GENERATE
                    </Button>
                </div>
            }
            isRequired={option.Required}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            description={
                canGenerate
                    ? helpDescription
                    : 'Enter your Filen email and password above, then press Generate.'
            }
            isDisabled={isDisabled}
        />
    )
}
