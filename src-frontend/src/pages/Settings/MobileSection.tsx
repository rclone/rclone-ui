import { useAutoAnimate } from '@formkit/auto-animate/react'
import { Button, Input } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'

import { CheckIcon, CopyIcon } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import {
    type TunnelInfo,
    cloudflaredInstalled,
    cloudflaredProvision,
    tunnelStart,
    tunnelStatus,
    tunnelStop,
} from '../../../lib/api/app'
import { message } from '../../../lib/api/dialog'
import { on as onAppEvent } from '../../../lib/api/events'
import { openUrl } from '../../../lib/api/shell'
import BaseSection from './BaseSection'

export default function MobileSection() {
    // The tunnel is owned by the server (it survives this page and is torn down on quit).
    const [cloudflaredTunnel, setCloudflaredTunnel] = useState<TunnelInfo | null>(null)
    useEffect(() => {
        tunnelStatus()
            .then(setCloudflaredTunnel)
            .catch(() => {})
        return onAppEvent('tunnel.changed', (info) => setCloudflaredTunnel(info))
    }, [])

    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const [animationParent] = useAutoAnimate()

    const handleCopyUrl = async (url: string) => {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const provisionCloudflaredMutation = useMutation({
        mutationFn: async () => {
            const success = await cloudflaredProvision()
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
            const installed = await cloudflaredInstalled()

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
            const info = await Promise.race([tunnelStart(), timeoutPromise])
            setCloudflaredTunnel(info)
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
        mutationFn: async () => {
            await tunnelStop()
            setCloudflaredTunnel(null)
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
                            onPress={() => stopTunnelMutation.mutate()}
                            isLoading={stopTunnelMutation.isPending}
                            data-focus-visible="false"
                        >
                            Disable
                        </Button>
                    )}
                </div>
            </div>

            <div ref={animationParent}>
                {cloudflaredTunnel && (
                    <div className="flex flex-col items-center gap-4">
                        <p className="text-medium text-neutral-400">Scan the QR Code</p>
                        <div className="p-4 bg-white rounded-lg">
                            <QRCodeSVG
                                value={JSON.stringify({
                                    url: cloudflaredTunnel.url,
                                    user: cloudflaredTunnel.user,
                                    pass: cloudflaredTunnel.pass,
                                })}
                                size={200}
                                level="M"
                            />
                        </div>
                        <Input
                            isReadOnly={true}
                            value={cloudflaredTunnel.url}
                            size="lg"
                            className="max-w-lg mt-7"
                            endContent={
                                <button
                                    type="button"
                                    onClick={() => handleCopyUrl(cloudflaredTunnel.url)}
                                    className="transition-colors text-neutral-400 hover:text-neutral-200"
                                >
                                    {copied ? (
                                        <CheckIcon size={18} className="text-success" />
                                    ) : (
                                        <CopyIcon size={18} />
                                    )}
                                </button>
                            }
                        />
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
