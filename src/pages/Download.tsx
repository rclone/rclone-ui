import { Button, Image, Input, Skeleton } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    Clipboard as ClipboardIcon,
    DownloadBracket as DownloadBracketIcon,
    Film as FilmIcon,
    Image as ImageIcon,
    Music as MusicIcon,
    Page as PageIcon,
} from '@zappicon/react'
import { AnimatePresence, motion } from 'framer-motion'
import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import type { Operations } from '../../lib/core/types'
import { onErrorDialog } from '../../lib/errors'
import { formOf } from '../../lib/operations'
import { startTransfer } from '../../lib/transfers'
import Alert from '../components/Alert'
import { IconTile } from '../components/look/IconTile'
import { Panel } from '../components/look/Panel'
import { SectionTitle } from '../components/look/SectionTitle'
import { TONE_RGB } from '../components/look/tones'
import OperationWindowContent, { OperationPage } from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import { pageLook } from '../components/operation/look'
import { BarText, StartButton, useSwap } from '../components/operation/OperationFooter'
import OperationHeader from '../components/operation/OperationHeader'
import { pickerFor } from '../components/operation/places'
import {
    type BarLine,
    downloadLine,
    placeWords,
    plainLine,
    segments,
} from '../components/operation/summary'
import { useOperationSubmission } from '../components/operation/useOperationSubmission'
import { bareField, PathField, RoutePanel, RouteRow } from '../components/PathFinder'
import { usePageStart, useReportEdited } from '../route'
import { fallbackFilename, filenameProblem } from './downloadFilename'
import {
    type LookupMiss,
    missOf,
    resolveLink,
    sitesDescription,
    useLinkSites,
} from './downloadSites'

const DESTINATION = pickerFor('download', 'destination')

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

function lineOf(filename: string | undefined, destination: string | undefined): BarLine {
    const name = filename?.trim()
    if (name) return downloadLine(name, destination)
    const place = placeWords(destination)
    return { title: segments(t`Download the file to ${place}`) }
}

const LOOKUP_DELAY = 400

export default function Download() {
    const start = usePageStart('download')
    const presetArgs = start.preset?.download ?? undefined

    const [url, setUrl] = useState<string | undefined>(start.url || undefined)
    const [destination, setDestination] = useState<string | undefined>(
        start.destination || undefined
    )
    const [filename, setFilename] = useState<string | undefined>(
        () => presetArgs?.filename || undefined
    )
    const [opened] = useState({ url, destination })
    const [filenameTyped, setFilenameTyped] = useState(false)
    const keepFilename = useRef(presetArgs?.filename ? presetArgs.url : undefined)
    const typedName = useRef(false)
    const keepsName = (url: string) => keepFilename.current === url || typedName.current
    const submitting = useRef(false)

    const sites = useLinkSites()
    const urlDescription = useMemo(
        () => sitesDescription(sites.data?.map((site) => site.name) ?? []),
        [sites.data]
    )

    const [downloadData, setDownloadData] = useState<
        | {
              url: string
              title: string
              extension: string
              type: 'video' | 'audio' | 'file' | 'image'
          }
        | undefined
    >()
    const [isFetchingDownloadData, setIsFetchingDownloadData] = useState(false)
    const [miss, setMiss] = useState<LookupMiss>()
    const [attempt, setAttempt] = useState(0)

    const submission = useOperationSubmission({
        operation: 'download',
        startLabel: t({ message: 'Download', comment: 'Button: starts the download.' }),
        start: (args: Operations.DownloadArgs) => {
            const problem = filenameProblem(args.filename ?? '')
            if (problem) throw new Error(problem)
            return startTransfer(
                formOf('download', { ...args, url: downloadData?.url || args.url }),
                {
                    preset: formOf('download', args),
                }
            )
        },
        problem: () => {
            if (!url) return t`Please enter a URL`
            if (!isValidUrl(url)) return t`Invalid URL`
            if (!destination) return t`Please select a destination path`
            if (isFetchingDownloadData) return undefined
            return filenameProblem(filename ?? '') || undefined
        },
        buildArgs: () => ({
            url: url ?? '',
            filename: filename ?? '',
            destination: destination ?? '',
        }),
        error: onErrorDialog(t`Download Error`, t`Failed to start download`, {
            log: ['[Download] Failed to start download'],
        }),
        reset: {
            paths: () => {
                setUrl(undefined)
                setDestination(undefined)
            },
            extras: () => {
                typedName.current = false
                setFilename(undefined)
                setDownloadData(undefined)
                setIsFetchingDownloadData(false)
                setMiss(undefined)
                setFilenameTyped(false)
            },
        },
    })
    const {
        buttonText,
        startBlocked,
        startIsPending,
        startIsSuccess,
        onStart,
        onResetAll,
        problem,
    } = submission.footer

    useReportEdited(
        !startIsSuccess &&
            (url !== opened.url || destination !== opened.destination || filenameTyped)
    )

    // biome-ignore lint/correctness/useExhaustiveDependencies: a press of "Try again" changes attempt, which looks the same link up once more
    useEffect(() => {
        if (!url || !isValidUrl(url)) {
            startTransition(() => {
                if (!typedName.current) setFilename(undefined)
                setDownloadData(undefined)
                setIsFetchingDownloadData(false)
                setMiss(undefined)
            })
            return
        }

        let aborted = false
        startTransition(() => {
            setDownloadData(undefined)
            setIsFetchingDownloadData(true)
            setMiss(undefined)
        })

        const keepPage = (kept: boolean) => {
            const pageName = fallbackFilename(url)
            startTransition(() => {
                if (!kept) setFilename(pageName)
                setDownloadData(undefined)
            })
        }

        let lookup: ReturnType<typeof resolveLink> | undefined
        const timer = setTimeout(() => {
            lookup = resolveLink(url)
            lookup
                .then((link) => {
                    if (aborted) return
                    const kept = keepsName(url)
                    keepFilename.current = undefined
                    if (link.found && link.filename) {
                        startTransition(() => {
                            if (!kept) setFilename(link.filename)
                            setDownloadData({
                                url: link.url,
                                title: link.filename,
                                extension: link.filename.split('.').pop() ?? '',
                                type: link.type as 'video' | 'audio' | 'file' | 'image',
                            })
                        })
                    } else {
                        keepPage(kept)
                    }

                    startTransition(() => {
                        setMiss(missOf(link))
                        setIsFetchingDownloadData(false)
                    })
                })
                .catch((error: unknown) => {
                    if (aborted) return
                    console.warn('[Download] Failed to resolve the link', error)
                    const kept = keepsName(url)
                    keepFilename.current = undefined
                    keepPage(kept)
                    startTransition(() => {
                        setMiss('unreachable')
                        setIsFetchingDownloadData(false)
                    })
                })
        }, LOOKUP_DELAY)

        return () => {
            aborted = true
            clearTimeout(timer)
            lookup?.cancel()
        }
    }, [url, attempt])

    const { tone } = pageLook()
    const swap = useSwap()
    const paste = () => {
        setTimeout(() => {
            navigator.clipboard
                .readText()
                .then((text) => {
                    setUrl(text)
                })
                .catch(() => {})
        }, 10)
    }
    const urlProblem = url && !isValidUrl(url) ? t`Invalid URL` : undefined
    const filenameError = filename?.trim() ? filenameProblem(filename) : undefined
    const found = isFetchingDownloadData ? undefined : downloadData

    return (
        <OperationPage>
            <OperationWindowContent>
                <OperationHeader
                    command={submission.command}
                    operation="download"
                    intro={t`Saves the content behind a link to a remote or local folder.`}
                />

                <RoutePanel tone={tone} note={{ kind: 'info', text: urlDescription }}>
                    <RouteRow stop="from" tone={tone}>
                        <div className="flex gap-1">
                            <Input
                                label={t({
                                    message: 'Link',
                                    comment: 'Label of the field for the web address to download.',
                                })}
                                placeholder={t`Enter a URL`}
                                value={url ?? ''}
                                onChange={(e) => setUrl(e.target.value)}
                                fullWidth={true}
                                size="lg"
                                isInvalid={!!urlProblem}
                                errorMessage={urlProblem}
                                classNames={bareField(!!urlProblem)}
                                data-focus-visible="false"
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck="false"
                            />
                            <Button
                                variant="flat"
                                onPress={paste}
                                startContent={<ClipboardIcon className="size-[18px]" />}
                                className="h-12 mt-2 font-medium rounded-[10px] shrink-0 text-default-700"
                                data-focus-visible="false"
                            >
                                <Trans comment="Button: pastes the copied link into the field.">
                                    Paste
                                </Trans>
                            </Button>
                        </div>
                    </RouteRow>
                    <div aria-hidden={true} className="flex items-center h-5">
                        <div className="relative self-stretch w-9 shrink-0">
                            <div
                                className="absolute inset-y-0 w-0.5 left-1/2 -translate-x-1/2"
                                style={{ background: `rgb(${TONE_RGB[tone]} / 0.35)` }}
                            />
                        </div>
                        <div className="flex-1 h-px ml-1 bg-divider" />
                    </div>
                    <RouteRow stop="to" tone={tone}>
                        <PathField
                            path={destination || ''}
                            setPath={setDestination}
                            label={t`Save to`}
                            placeholder={t`Enter a remote:path, or click to choose a folder`}
                            showPicker={true}
                            allowedKeys={DESTINATION.allowedKeys}
                            showFiles={DESTINATION.files}
                            remember={DESTINATION.remember}
                            bare={true}
                        />
                    </RouteRow>
                    <RouteRow stop="none" tone={tone}>
                        <Input
                            label={t`Filename`}
                            placeholder={t`Enter a filename and extension`}
                            value={filename ?? ''}
                            onChange={(e) => {
                                typedName.current = e.target.value !== ''
                                setFilename(e.target.value)
                                setFilenameTyped(true)
                            }}
                            fullWidth={true}
                            isDisabled={!url || !destination}
                            isInvalid={!!filenameError}
                            errorMessage={filenameError}
                            classNames={bareField(!!filenameError)}
                            size="lg"
                            data-focus-visible="false"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck="false"
                        />
                    </RouteRow>
                </RoutePanel>

                {!url?.trim() && (
                    <div className="flex items-center gap-3.5 p-4 border border-dashed rounded-2xl border-default-300 dark:border-default-200">
                        <IconTile icon={DownloadBracketIcon} tone={tone} size="lg" />
                        <p className="leading-snug text-small text-default-500 text-pretty">
                            <Trans>
                                Paste a link to a file, or to a page with a video, an image or audio
                                on it. A preview shows here before you download.
                            </Trans>
                        </p>
                    </div>
                )}

                {(isFetchingDownloadData || miss || found) && (
                    <section aria-label={t`Preview`} className="flex flex-col gap-3">
                        <SectionTitle className="px-1" title={t`Preview`} />
                        {isFetchingDownloadData ? (
                            <Panel className="flex items-center gap-3.5 p-4">
                                <Skeleton className="rounded-[10px] size-9 shrink-0" />
                                <div className="flex flex-col flex-1 gap-2">
                                    <Skeleton className="w-2/5 h-3.5 rounded-full" />
                                    <Skeleton className="w-3/5 h-3 rounded-full" />
                                </div>
                                <span className="sr-only">
                                    <Trans>Looking up the link</Trans>
                                </span>
                            </Panel>
                        ) : miss ? (
                            <Alert
                                color="warning"
                                variant="faded"
                                title={
                                    miss === 'unreachable'
                                        ? t`This link could not be looked up`
                                        : t`The file behind this link could not be found`
                                }
                                description={
                                    miss === 'unreachable'
                                        ? t`The service that finds the file behind a link couldn't be reached. Downloading now will save the link itself, not the video, audio or other content behind it. This means you will download a web page. Check your connection, or try again in a moment.`
                                        : t`Downloading now will save the link itself, not the video, audio or other content behind it. This means you will download a web page. Check the link, or try again in a moment.`
                                }
                                endContent={
                                    <Button
                                        size="sm"
                                        variant="flat"
                                        color="warning"
                                        className="self-center shrink-0"
                                        onPress={() => setAttempt((n) => n + 1)}
                                        data-focus-visible="false"
                                    >
                                        <Trans comment="Button: looks the link up once more.">
                                            Try again
                                        </Trans>
                                    </Button>
                                }
                            />
                        ) : found ? (
                            <Panel className="flex flex-col overflow-hidden">
                                <div className="flex items-center gap-3.5 p-4">
                                    <IconTile icon={MEDIA_ICON[found.type]} tone={tone} size="lg" />
                                    <div className="flex flex-col min-w-0">
                                        <span className="font-medium truncate">{found.title}</span>
                                        <span className="text-small text-default-500">
                                            {MEDIA_LABEL[found.type]}
                                            {found.extension
                                                ? ` · ${found.extension.toUpperCase()}`
                                                : ''}
                                        </span>
                                    </div>
                                </div>
                                {found.type === 'video' && !isYoutubeUrl(url || '') && (
                                    <video
                                        autoPlay={true}
                                        muted={true}
                                        playsInline={true}
                                        controls={true}
                                        src={found.url}
                                        className="object-contain w-full h-64 bg-black"
                                    >
                                        <track kind="captions" src="" srcLang="en" />
                                    </video>
                                )}
                                {found.type === 'image' && (
                                    <div className="flex justify-center p-4 pt-0">
                                        <Image
                                            src={found.url}
                                            className="object-contain w-full h-64"
                                        />
                                    </div>
                                )}
                                {found.type === 'audio' && (
                                    <div className="px-4 pb-4">
                                        <audio src={found.url} controls={true} className="w-full">
                                            <track kind="captions" src="" srcLang="en" />
                                        </audio>
                                    </div>
                                )}
                            </Panel>
                        ) : null}
                    </section>
                )}
            </OperationWindowContent>

            <OperationWindowFooter>
                <BarText
                    line={
                        startIsSuccess
                            ? plainLine(t`Download started`, t`Open History to see the status.`)
                            : lineOf(filename, destination)
                    }
                    problem={
                        !startIsSuccess && !startIsPending && startBlocked ? problem : undefined
                    }
                    status={startIsSuccess ? 'success' : startIsPending ? 'active' : undefined}
                />
                <AnimatePresence mode="wait" initial={false}>
                    {startIsSuccess ? (
                        <motion.div key="started-buttons" {...swap} className="flex gap-2 shrink-0">
                            <StartButton onPress={onResetAll}>
                                <Trans>New download</Trans>
                            </StartButton>
                        </motion.div>
                    ) : (
                        <motion.div key="start-button" {...swap} className="flex gap-2 shrink-0">
                            <StartButton
                                onPress={() => {
                                    if (submitting.current) return
                                    submitting.current = true
                                    onStart().finally(() => {
                                        submitting.current = false
                                    })
                                }}
                                isDisabled={
                                    startIsPending || startBlocked || isFetchingDownloadData
                                }
                                isLoading={startIsPending}
                                endContent={
                                    startIsPending ? undefined : (
                                        <DownloadBracketIcon className="size-4" />
                                    )
                                }
                            >
                                {buttonText}
                            </StartButton>
                        </motion.div>
                    )}
                </AnimatePresence>
            </OperationWindowFooter>
        </OperationPage>
    )
}

const MEDIA_ICON = { video: FilmIcon, audio: MusicIcon, image: ImageIcon, file: PageIcon } as const

const MEDIA_LABEL = {
    video: t({ message: 'Video', comment: 'The kind of file that a link holds.' }),
    audio: t({ message: 'Audio', comment: 'The kind of file that a link holds.' }),
    image: t({ message: 'Image', comment: 'The kind of file that a link holds.' }),
    file: t({ message: 'File', comment: 'The kind of file that a link holds.' }),
} as const
