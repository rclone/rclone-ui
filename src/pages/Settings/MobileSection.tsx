import { useAutoAnimate } from '@formkit/auto-animate/react'
import { Button, Input } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { message } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { isCloudflaredInstalled } from '../../../lib/cloudflared/common'
import { provisionCloudflared } from '../../../lib/cloudflared/init'
import { type RcSession, getLocalSession } from '../../../lib/rclone/session'
import { useStore } from '../../../store/memory'
import BaseSection from './BaseSection'

export default function MobileSection() {
    const cloudflaredTunnel = useStore((state) => state.cloudflaredTunnel)

    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState<string | null>(null)

    const [session, setSession] = useState<RcSession | null>(null)
    useEffect(() => {
        getLocalSession().then(setSession, (e) => {
            console.error('[MobileSection] failed to get the rc password', e)
            setError('Failed to get the password of the local rclone')
        })
    }, [])

    const [animationParent] = useAutoAnimate()

    const handleCopy = async (field: string, value: string) => {
        await navigator.clipboard.writeText(value)
        setCopied(field)
        setTimeout(() => setCopied((current) => (current === field ? null : current)), 2000)
    }

    const provisionCloudflaredMutation = useMutation({
        mutationFn: async () => {
            const success = await provisionCloudflared()
            if (!success) {
                throw new Error('Failed to download cloudflared')
            }
        },
        onError: async (e) => {
            const errorMsg = e instanceof Error ? e.message : String(e)
            setError(errorMsg)
            await message(`Failed to download cloudflared: ${errorMsg}`, {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    const startTunnelMutation = useMutation({
        mutationFn: async () => {
            setError(null)
            // Check if cloudflared is installed
            const installed = await isCloudflaredInstalled()

            if (!installed) {
                await provisionCloudflaredMutation.mutateAsync()
            }

            // Create a 15-second timeout
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                    reject(new Error('Tunnel startup timed out after 15 seconds'))
                }, 15000)
            })

            // Race between the tunnel starting and the timeout
            const result = await Promise.race([
                invoke<[number, string]>('start_cloudflared_tunnel'),
                timeoutPromise,
            ])

            const [pid, url] = result
            useStore.setState({ cloudflaredTunnel: { pid, url } })
        },
        onError: async (e) => {
            const errorMsg = e instanceof Error ? e.message : String(e)
            setError(errorMsg)
            await message(`Failed to start tunnel: ${errorMsg}`, {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    const stopTunnelMutation = useMutation({
        mutationFn: async (pid: number) => {
            await invoke('stop_cloudflared_tunnel', { pid })
            useStore.setState({ cloudflaredTunnel: null })
        },
        onError: async (e) => {
            const errorMsg = e instanceof Error ? e.message : String(e)
            await message(`Failed to stop tunnel: ${errorMsg}`, {
                title: 'Error',
                kind: 'error',
            })
        },
    })

    return (
        <BaseSection header={{ title: 'Mobile' }}>
            <div className="flex flex-row justify-center w-full gap-8 px-8">
                <div className="flex flex-col items-end flex-1 gap-2">
                    <h3 className="font-medium">Mobile Session</h3>
                    <p className="text-xs text-neutral-500 text-end">
                        Start a new tunnel to manage rclone from your phone
                    </p>
                </div>

                <div className="flex flex-col w-3/5 gap-4">
                    {!cloudflaredTunnel && (
                        <>
                            <Button
                                size="lg"
                                color="primary"
                                onPress={() => startTunnelMutation.mutate()}
                                isLoading={
                                    startTunnelMutation.isPending ||
                                    provisionCloudflaredMutation.isPending
                                }
                                data-focus-visible="false"
                            >
                                {provisionCloudflaredMutation.isPending ||
                                startTunnelMutation.isPending
                                    ? 'Initializing...'
                                    : 'Tap to enable'}
                            </Button>
                            {error && <p className="text-sm text-danger">{error}</p>}
                        </>
                    )}

                    {cloudflaredTunnel && (
                        <Button
                            size="lg"
                            color="danger"
                            variant="flat"
                            onPress={() => stopTunnelMutation.mutate(cloudflaredTunnel.pid)}
                            isLoading={stopTunnelMutation.isPending}
                            data-focus-visible="false"
                        >
                            Disable
                        </Button>
                    )}
                </div>
            </div>

            <div ref={animationParent}>
                {cloudflaredTunnel && session && (
                    <div className="flex flex-col items-center gap-4">
                        <p className="text-medium text-neutral-400">Scan the QR Code</p>
                        <div className="p-4 bg-white rounded-lg">
                            <QRCodeSVG
                                value={JSON.stringify({
                                    url: cloudflaredTunnel.url,
                                    user: session.user,
                                    pass: session.pass,
                                })}
                                size={200}
                                level="M"
                            />
                        </div>
                        <div className="flex flex-col w-full max-w-lg gap-3 mt-7">
                            {(
                                [
                                    ['url', 'URL', cloudflaredTunnel.url],
                                    ['user', 'User', session.user],
                                    ['pass', 'Password', session.pass],
                                ] as const
                            ).map(([field, label, value]) => (
                                <Input
                                    key={field}
                                    isReadOnly={true}
                                    label={label}
                                    labelPlacement="outside-left"
                                    value={value}
                                    size="lg"
                                    classNames={{
                                        base: 'w-full',
                                        mainWrapper: 'flex-1',
                                        label: 'w-20',
                                    }}
                                    endContent={
                                        <button
                                            type="button"
                                            aria-label={`Copy ${label}`}
                                            onClick={() => handleCopy(field, value)}
                                            className="transition-colors text-neutral-400 hover:text-neutral-200"
                                        >
                                            {copied === field ? (
                                                <CheckIcon size={18} className="text-success" />
                                            ) : (
                                                <CopyIcon size={18} />
                                            )}
                                        </button>
                                    }
                                />
                            ))}
                        </div>
                        <p className="max-w-lg text-sm text-center text-neutral-500">
                            The password changes when Rclone UI restarts.
                        </p>
                    </div>
                )}

                {!cloudflaredTunnel && (
                    <div className="flex flex-col items-center gap-2 overflow-hidden max-h-[525px]">
                        <img src={'/mobile.png'} alt="Mobile" className="w-full px-10" />

                        <div className="absolute left-0 right-0 flex flex-col items-center bottom-5">
                            <p className="p-2 px-3.5 text-medium text-primary-800 bg-content2 border-1 border-divider rounded-small">
                                Download on the{' '}
                                <span
                                    className="font-medium !cursor-pointer hover:text-primary-foreground"
                                    onClick={() =>
                                        openUrl('https://apps.apple.com/app/rclone-ui/id6756127598')
                                    }
                                >
                                    App Store
                                </span>{' '}
                                and{' '}
                                <span
                                    className="font-medium !cursor-pointer hover:text-primary-foreground"
                                    onClick={() =>
                                        openUrl(
                                            'https://play.google.com/store/apps/details?id=com.rclone.mobile'
                                        )
                                    }
                                >
                                    Google Play
                                </span>
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </BaseSection>
    )
}
