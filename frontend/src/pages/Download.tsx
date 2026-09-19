import { Button, ButtonGroup, Image, Input, Spinner, Tooltip } from '@heroui/react'
import MuxPlayer from '@mux/mux-player-react'
import { useMutation } from '@tanstack/react-query'

import { AnimatePresence, motion } from 'framer-motion'
import { AlertOctagonIcon, ClockIcon, DownloadIcon, FoldersIcon } from 'lucide-react'
import { startTransition, useEffect, useMemo, useState } from 'react'
import { useOperationPreset } from '../components/operation/useOperationPreset'
import { UserCancelledError, onErrorDialog } from '../../lib/errors'
import { notify } from '../../lib/notifications'
import { pathsProblem } from '../../lib/paths'
import { startDownload } from '../../lib/rclone/api'
import CommandInfoButton from '../components/CommandInfoButton'
import OperationWindowContent from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import { PathField } from '../components/PathFinder'
import { message } from '../../lib/api/dialog'
import { openUrl } from '../../lib/api/shell'

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
              title: string
              extension: string
              type: 'video' | 'audio' | 'file' | 'image'
          }
        | undefined
    >()
    const [isFetchingDownloadData, setIsFetchingDownloadData] = useState(false)

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
                capture: false,
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

        console.log('[Download] Fetching download data for URL:', url)

        const abortController = new AbortController()
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

        let parsedFilename: typeof filename
        let parsedDownloadData: typeof downloadData

        fetch(`https://rcloneui.com/api/download?url=${encodeURIComponent(url)}`, {
            signal: abortController.signal,
        })
            .then(async (response) => {
                if (response.ok) {
                    const result = (await response.json()) as {
                        data?: {
                            url: string
                            title: string
                            extension: string
                            type: 'video' | 'audio' | 'file' | 'image'
                        }[]
                    }

                    if (result.data && Array.isArray(result.data) && result.data.length > 0) {
                        console.log('[Download] Successfully fetched download data')
                        const item = result.data[0]
                        parsedDownloadData = {
                            sourceUrl: url,
                            url: item.url,
                            title: item.title,
                            extension: item.extension,
                            type: item.type,
                        }
                        parsedFilename = `${item.title.substring(0, 42).trim()}.${item.extension || 'txt'}`
                        console.log(parsedDownloadData)
                        console.log(parsedFilename)
                    }
                }

                if (abortController.signal.aborted) return
                if (parsedFilename && parsedDownloadData) {
                    console.log('[Download] Setting filename and download data')
                    startTransition(() => {
                        setFilename(parsedFilename)
                        setDownloadData(parsedDownloadData)
                    })
                } else {
                    parsedFilename = fallbackFilename()
                    startTransition(() => {
                        setFilename(parsedFilename)
                        setDownloadData(undefined)
                    })
                }

                startTransition(() => {
                    setIsFetchingDownloadData(false)
                })
            })
            .catch(() => {
                // The lookup failed (or was abandoned): the URL is still downloadable as it is.
                if (abortController.signal.aborted) return
                startTransition(() => {
                    setFilename(fallbackFilename())
                    setDownloadData(undefined)
                    setIsFetchingDownloadData(false)
                })
            })

        return () => {
            abortController.abort()
        }
    }, [url])

    return (
        <div className="flex flex-col h-screen gap-2">
            {/* Main Content */}
            <OperationWindowContent className="gap-4">
                <Input
                    label="URL"
                    placeholder="Enter a URL"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    fullWidth={true}
                    description="Supports Youtube, TikTok, SoundCloud, Google Drive, etc."
                    size="lg"
                    data-focus-visible="false"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                    endContent={
                        <Button
                            variant="faded"
                            color="primary"
                            onPress={() => {
                                setTimeout(() => {
                                    navigator.clipboard.readText().then((text) => {
                                        setUrl(text)
                                    })
                                }, 10)
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
                    <Tooltip content="Schedule task" placement="top" size="lg" color="foreground">
                        <Button
                            size="lg"
                            type="button"
                            color="primary"
                            isIconOnly={true}
                            onPress={async () => {
                                const res = await message(
                                    'Not yet implemented, you can request this feature on GitHub.',
                                    {
                                        title: 'Schedule Downloads',
                                        kind: 'info',
                                        buttons: {
                                            ok: 'Request Feature',
                                        },
                                    }
                                )

                                if (res === 'Ok') {
                                    await openUrl(
                                        'https://github.com/rclone-ui/rclone-ui/issues/18'
                                    )
                                }
                            }}
                        >
                            <ClockIcon className="size-6" />
                        </Button>
                    </Tooltip>
                    <CommandInfoButton
                        command="copyurl"
                    />
                </ButtonGroup>
            </OperationWindowFooter>
        </div>
    )
}
