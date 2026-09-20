import { Button, ButtonGroup, Checkbox, Image, Input, Spinner, Tooltip } from '@heroui/react'
import MuxPlayer from '@mux/mux-player-react'
import { useMutation } from '@tanstack/react-query'

import { AnimatePresence, motion } from 'framer-motion'
import { AlertOctagonIcon, DownloadIcon, FoldersIcon } from 'lucide-react'
import { startTransition, useEffect, useMemo, useState } from 'react'
import { useOperationPreset } from '@/components/operation/useOperationPreset'
import { UserCancelledError, onErrorDialog } from '@/lib/errors'
import { notify } from '@/lib/notifications'
import { pathsProblem } from '@/lib/paths'
import { startDownload } from './startDownload'
import { type ResolvedLink, resolveLink } from '@/server/app'
import { CommandInfoButton } from '@/components/operation/OperationFooter'
import OperationWindowContent from '@/components/OperationWindowContent'
import OperationWindowFooter from '@/components/OperationWindowFooter'
import { PathField } from '@/components/PathFinder'
import { navigate } from '@/navigate'
import { usePersistedStore } from '@/store'

/** The websites `resolve_link` knows (the hosts in `src/resolve_link.rs`), as the tooltip names them. */
const RESOLVED_SITES = [
    'Instagram',
    'TikTok',
    'Facebook',
    'X (Twitter)',
    'YouTube',
    'MediaFire',
    'CapCut',
    'Google Drive',
    'Pinterest',
    'Douyin',
    'Rednote (Xiaohongshu)',
    'Threads',
    'Kuaishou',
    'SnackVideo',
    'Cocofun',
    'Spotify',
    'SoundCloud',
]

function isValidUrl(url: string) {
    try {
        new URL(url)
        return true
    } catch {
        return false
    }
}

function isYoutubeUrl(url: string) {
    return url.includes('youtube.com') || url.includes('youtu.be')
}

function getDateFilename() {
    return new Date()
        .toLocaleString(undefined, {
            dateStyle: 'short',
            timeStyle: 'medium',
        })
        .replace(',', ' at')
        .replace(/[\/]/g, '-')
        .replace(/[:]/g, '.')
}

function getUrlDomain(url: string) {
    const hostname = new URL(url).hostname
    return hostname.split('.').slice(0, -1).join('.') || hostname.split('.')[0]
}

export default function Download() {
    const { preset } = useOperationPreset('download')

    const [url, setUrl] = useState<string | undefined>(preset?.args.url)
    const [destination, setDestination] = useState<string | undefined>(preset?.args.destination)
    const [filename, setFilename] = useState<string | undefined>(preset?.args.filename)

    const [downloadData, setDownloadData] = useState<
        | {
              /** The URL in the field this was resolved for. */
              sourceUrl: string
              url: string
              type: ResolvedLink['type']
          }
        | undefined
    >()
    const [isFetchingDownloadData, setIsFetchingDownloadData] = useState(false)
    const disableLinkResolution = usePersistedStore((state) => state.disableLinkResolution)
    const setDisableLinkResolution = usePersistedStore((state) => state.setDisableLinkResolution)

    const startDownloadMutation = useMutation({
        mutationFn: async () => {
            if (!url) {
                throw new Error('Please enter a URL')
            }

            if (!destination) {
                throw new Error('Please select a destination path')
            }
            const problem = pathsProblem([destination])
            if (problem) throw new Error(problem)

            if (!filename) {
                throw new Error('Please enter a filename')
            }

            // Resolved metadata counts only for the URL it was resolved for: a lookup that
            // failed for a newer URL must not download the previous one.
            const downloadUrl = downloadData?.sourceUrl === url ? downloadData.url : url

            // One attempt, through the recorded start like every transfer: a start that is
            // retried because its reply got lost downloads twice.
            await startDownload({ url: downloadUrl, fs: destination, remote: filename })
        },
        onSuccess: async () => {
            await notify({
                title: 'Success',
                body: 'Download task started',
            })
        },
        onError: (error) => {
            // Declining to reconnect a remote is an answer, not a failure to report.
            if (error instanceof UserCancelledError) return
            return onErrorDialog('Download Error', 'Failed to start download', {
                okLabel: 'OK',
                log: ['[Download] Failed to start download'],
            })(error)
        },
    })

    const buttonText = useMemo(() => {
        if (startDownloadMutation.isPending) return 'STARTING...'
        if (!url) return 'Please enter a URL'
        if (!isValidUrl(url)) return 'Invalid URL'
        if (!destination) return 'Please select a destination path'
        if (pathsProblem([destination])) return 'Fix the destination path'
        return 'DOWNLOAD'
    }, [startDownloadMutation.isPending, url, destination])

    const buttonIcon = useMemo(() => {
        if (startDownloadMutation.isPending) return <Spinner size="lg" />
        if (!url) return <AlertOctagonIcon className="w-5 h-5" />
        if (!isValidUrl(url)) return <AlertOctagonIcon className="w-5 h-5" />
        if (!destination) return <FoldersIcon className="w-5 h-5" />
        return <DownloadIcon className="w-5 h-5 fill-current" />
    }, [startDownloadMutation.isPending, url, destination])

    useEffect(() => {
        if (!url || !isValidUrl(url)) {
            startTransition(() => {
                setFilename(undefined)
                setDownloadData(undefined)
                setIsFetchingDownloadData(false)
            })
            return
        }

        let abandoned = false
        startTransition(() => {
            // The previous URL's metadata is no longer about this one.
            setDownloadData(undefined)
            setIsFetchingDownloadData(true)
        })
        // A name from the URL itself, for a lookup that finds nothing or fails.
        const fallbackFilename = () => {
            const extractedExtension = url.split('.').pop()?.split('?')[0]?.toLowerCase()
            return extractedExtension
                ? url.split('/').pop()?.split('?')[0]
                : `${getUrlDomain(url)} ${getDateFilename()}.txt`
        }

        // Once the typing stops: the server asks a link service about every URL it is sent.
        const timer = setTimeout(async () => {
            const resolved = disableLinkResolution
                ? null
                : await resolveLink(url).catch((error) => {
                      // The lookup failed: the URL is still downloadable as it is.
                      console.warn('[Download] link lookup failed', error)
                      return null
                  })
            if (abandoned) return
            startTransition(() => {
                setFilename(resolved?.filename ?? fallbackFilename())
                setDownloadData(
                    resolved
                        ? { sourceUrl: url, url: resolved.url, type: resolved.type }
                        : undefined
                )
                setIsFetchingDownloadData(false)
            })
        }, 400)

        return () => {
            abandoned = true
            clearTimeout(timer)
        }
    }, [url, disableLinkResolution])

    return (
        <div className="flex flex-col h-full gap-2">
            {/* Main Content */}
            <OperationWindowContent className="gap-4">
                <Input
                    label="URL"
                    placeholder="Enter a URL"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    fullWidth={true}
                    size="lg"
                    data-focus-visible="false"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                    description={
                        <Tooltip
                            placement="bottom-start"
                            color="foreground"
                            content={
                                <div className="flex flex-col max-w-xs gap-2 py-1">
                                    <p>
                                        A link to one of these websites is a page, not a file. An
                                        external provider resolves it to the downloadable file
                                        behind it:
                                    </p>
                                    <p className="opacity-70">{RESOLVED_SITES.join(', ')}</p>
                                    <p>
                                        Only links to these websites are sent. Check this to send
                                        none: downloading from these websites will stop working.
                                    </p>
                                </div>
                            }
                        >
                            <span className="inline-flex">
                                <Checkbox
                                    size="sm"
                                    radius="sm"
                                    isSelected={disableLinkResolution}
                                    onValueChange={setDisableLinkResolution}
                                    classNames={{ label: 'text-tiny text-foreground-400' }}
                                >
                                    Disable external content resolution
                                </Checkbox>
                            </span>
                        </Tooltip>
                    }
                    endContent={
                        <Button
                            variant="faded"
                            color="primary"
                            onPress={() => {
                                navigator.clipboard.readText().then((text) => {
                                    setUrl(text)
                                })
                            }}
                        >
                            Paste
                        </Button>
                    }
                />

                {/* Path Display */}
                <PathField
                    path={destination || ''}
                    setPath={setDestination}
                    label="Destination"
                    description="Select the destination folder or manually enter a folder path"
                    placeholder="Enter a remote:path as destination"
                    showPicker={true}
                    showFiles={false}
                />

                <Input
                    label="Filename"
                    placeholder="Enter a filename"
                    description="Make sure to include an extension"
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    fullWidth={true}
                    isDisabled={!url || !destination}
                    size="lg"
                    data-focus-visible="false"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                />
            </OperationWindowContent>

            <div className="flex items-center justify-center flex-1 overflow-hidden">
                {isFetchingDownloadData && <Spinner size="lg" />}

                {!isFetchingDownloadData &&
                    downloadData &&
                    downloadData.type === 'video' &&
                    !isYoutubeUrl(url || '') && (
                        <MuxPlayer
                            autoPlay={true}
                            muted={true}
                            // controls={true}
                            src={downloadData.url}
                            className="object-contain w-full h-64 mx-10 overflow-hidden rounded-large"
                        />
                    )}

                {!isFetchingDownloadData && downloadData && downloadData.type === 'image' && (
                    <Image src={downloadData.url} className="object-contain w-full h-64" />
                )}

                {!isFetchingDownloadData && downloadData && downloadData.type === 'audio' && (
                    <audio src={downloadData.url} controls={true}>
                        <track kind="captions" src="" srcLang="en" />
                    </audio>
                )}
            </div>

            <OperationWindowFooter>
                <AnimatePresence mode="wait" initial={false}>
                    {startDownloadMutation.isSuccess ? (
                        <motion.div
                            key="started-buttons"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            className="flex flex-1 gap-2"
                        >
                            <Button
                                fullWidth={true}
                                color="primary"
                                size="lg"
                                onPress={() => {
                                    startTransition(() => {
                                        setUrl(undefined)
                                        setDestination(undefined)
                                        setFilename(undefined)
                                        setDownloadData(undefined)
                                        setIsFetchingDownloadData(false)
                                        startDownloadMutation.reset()
                                    })
                                }}
                                data-focus-visible="false"
                            >
                                NEW DOWNLOAD
                            </Button>
                            <Button
                                fullWidth={true}
                                size="lg"
                                color="secondary"
                                onPress={() => navigate('/transfers')}
                                data-focus-visible="false"
                            >
                                VIEW TRANSFERS
                            </Button>
                        </motion.div>
                    ) : (
                        <motion.div
                            key="start-button"
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            className="flex flex-1"
                        >
                            <Button
                                onPress={() => startDownloadMutation.mutate()}
                                size="lg"
                                fullWidth={true}
                                type="button"
                                color="primary"
                                isDisabled={
                                    startDownloadMutation.isPending ||
                                    !destination ||
                                    !!pathsProblem([destination]) ||
                                    isFetchingDownloadData
                                }
                                isLoading={startDownloadMutation.isPending}
                                endContent={buttonIcon}
                                className="gap-2"
                                data-focus-visible="false"
                            >
                                {buttonText}
                            </Button>
                        </motion.div>
                    )}
                </AnimatePresence>
                <ButtonGroup variant="flat">
                    <CommandInfoButton command="copyurl" />
                </ButtonGroup>
            </OperationWindowFooter>
        </div>
    )
}
