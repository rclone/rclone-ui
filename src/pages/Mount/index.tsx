import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Folder as FolderIcon } from '@zappicon/react'
import { startTransition, useEffect, useMemo, useState } from 'react'
import { useFlags } from '../../../lib/catalog'
import { formatErrorMessage, reportError } from '../../../lib/errors'
import { getRemoteName } from '../../../lib/format'
import {
    cannotMount,
    explainMountSupport,
    startMount,
    stopMount,
    useMounts,
} from '../../../lib/mounts'
import { pathProblem } from '../../../lib/paths'
import { pathsFromArgs } from '../../../lib/rclone/templatePaths'
import { homeDir, message, platform, revealPath } from '../../../lib/shell'
import { SectionTitle } from '../../components/look/SectionTitle'
import OperationWindowContent, { OperationPage } from '../../components/OperationWindowContent'
import OperationWindowFooter from '../../components/OperationWindowFooter'
import OperationFooter from '../../components/operation/OperationFooter'
import OperationHeader from '../../components/operation/OperationHeader'
import { OptionsSection } from '../../components/operation/OptionsAccordion'
import { mountLine, placeWords, segments } from '../../components/operation/summary'
import { useOperationSubmission } from '../../components/operation/useOperationSubmission'
import { useOptionGroups } from '../../components/operation/useOptionGroups'
import { useOptionItems } from '../../components/operation/useOptionItems'
import { PathFinder } from '../../components/PathFinder'
import { toastSuccess } from '../../components/toast'
import { usePageStart, useReportEdited } from '../../route'
import CacheMode from './CacheMode'
import { isDrive, mountPointOf, suggestedMountPoint, tildePath } from './mountPoint'
import { MountList, MountSupportNotice, StoppedMounts } from './running'

export default function Mount() {
    const home = homeDir()
    const windows = platform() === 'windows'
    const start = usePageStart('mount')
    const presetArgs = start.preset?.mount ?? undefined
    const { globalFlags } = useFlags()

    const [source, setSource] = useState<string | undefined>(start.sources?.[0])
    // The mount point that the user typed or picked. While it is undefined, the suggestion is used.
    const [dest, setDest] = useState<string | undefined>(start.destination)
    const [opened] = useState({ source, dest })

    // The remote's name, for the suggested mount point. An on-the-fly remote such as ":s3" is
    // named after its type.
    const remote = useMemo(() => {
        const name = getRemoteName(source)
        return name?.startsWith(':') ? name.slice(1) : (name ?? undefined)
    }, [source])
    const suggestion = remote ? suggestedMountPoint(remote, home, windows) : undefined
    const mountPoint = mountPointOf(dest, suggestion, windows)

    const optionState = useOptionGroups({
        operation: 'mount',
        groups: ['mount', 'vfs', 'filter', 'config', 'metadata'],
        initial: presetArgs?.options,
    })
    const {
        jsonError,
        edited: optionsEdited,
        groups,
        applyTemplate,
        getMergedOptions,
        resetJson,
    } = optionState

    // buildArgs runs only after `problem` passes, so the source and the mount point are set.
    const buildArgs = () => ({
        source: source ?? '',
        destination: mountPoint ?? '',
        options: {
            mount: groups.mount.sent,
            vfs: groups.vfs.sent,
            filter: groups.filter.sent,
            config: groups.config.sent,
            metadata: groups.metadata.sent,
        },
    })

    const submission = useOperationSubmission({
        operation: 'mount',
        start: startMount,
        pendingLabel: t`Mounting…`,
        problem: () => {
            if (!source) return t`Please select a source path`
            if (!mountPoint) return t`Please select a mount point`
            if (source === mountPoint) return t`Source and destination cannot be the same`
            return undefined
        },
        // On Windows, a drive (M:, or * for the next free one) is not a path, so it isn't sent
        // as the destination path.
        paths: (args) => ({
            source: args.source,
            destination: isDrive(args.destination ?? '', windows) ? undefined : args.destination,
        }),
        jsonError,
        buildArgs,
        error: async (failure) => {
            // On a computer that can't mount, the can't-mount dialog explains how to set it up.
            if (cannotMount(failure) && (await explainMountSupport().catch(() => false))) return
            if (!cannotMount(failure)) {
                await message(formatErrorMessage(failure), {
                    title: t`The mount failed`,
                    kind: 'error',
                })
                return
            }
            console.error('[Mount] Failed to start mount:', failure)
            await reportError(failure, {
                title: t`Mount Error`,
                fallback: t`Failed to start mount operation`,
            })
        },
        reset: {
            paths: () => {
                setSource(undefined)
                setDest(undefined)
            },
        },
        groups: { resetJson },
    })
    // The started mount. On Windows, a `*` mount point is replaced by the drive the core picked.
    const mounted = submission.startMutation.data
    const resetStart = submission.startMutation.reset

    useReportEdited(!mounted && (optionsEdited || source !== opened.source || dest !== opened.dest))

    // When the started mount is unmounted elsewhere (in the list below, the launcher or the tray),
    // the page gets ready to mount again. The mount counts as gone only after it has appeared in
    // the list and then left it.
    const { mounts } = useMounts()
    const startedId = mounted?.id
    const listed = !!startedId && mounts.some((m) => m.id === startedId)
    const [seen, setSeen] = useState(false)
    useEffect(() => {
        if (listed) {
            setSeen(true)
        } else if (seen) {
            setSeen(false)
            resetStart()
        }
    }, [listed, seen, resetStart])

    const openMount = async () => {
        const at = mounted?.mountPoint
        if (!at) return
        try {
            await revealPath(at)
        } catch (error) {
            console.error('[Mount] Error opening path:', error)
            const reason = formatErrorMessage(error)
            await message(t`Failed to open ${at} (${reason})`, {
                title: t`Open Error`,
                kind: 'error',
            })
        }
    }

    const unmount = async () => {
        const id = mounted?.id
        if (!id) return
        try {
            await stopMount(id)
            const place = mounted.mountPoint
            toastSuccess(t`Unmounted ${place}`)
            startTransition(() => {
                setSeen(false)
                resetStart()
            })
        } catch (error) {
            await reportError(error, {
                title: t`Unmount`,
                fallback: t`Couldn't unmount`,
            })
        }
    }

    const accordionItems = useOptionItems(optionState, {
        refusals: submission.refusals,
        // The mounted source is where the mapper's fields come from and go to.
        mapperPaths: { destination: source },
    })

    const appWideCache = globalFlags?.vfs?.vfs_cache_mode

    const mountedAt = mounted ? placeWords(tildePath(mounted.mountPoint, home)) : ''
    const mountedLine = mounted
        ? {
              title: segments(t`Mounted at ${mountedAt}`),
              detail: t`The files are now available to any app.`,
          }
        : undefined

    return (
        <OperationPage>
            <OperationWindowContent>
                <OperationHeader
                    command={submission.command}
                    operation="mount"
                    intro={t`Shows your storage as a folder on this computer, so any app can open its files.`}
                    templates={{
                        isDisabled: submission.templatesDisabled,
                        onSelect: applyTemplate,
                        getOptions: getMergedOptions,
                        paths: {
                            // The mount point as typed or picked, not the suggestion.
                            get: () => pathsFromArgs({ source, destination: dest }),
                            set: (paths) => {
                                setSource(paths.sources?.[0] || undefined)
                                if (paths.destination) setDest(paths.destination)
                            },
                        },
                    }}
                />

                <MountSupportNotice />
                <StoppedMounts />
                <MountList />

                <section aria-label={t`New mount`} className="flex flex-col gap-3">
                    {mounts.length > 0 && <SectionTitle className="px-1" title={t`New mount`} />}
                    <PathFinder
                        sourcePath={source}
                        setSourcePath={setSource}
                        destPath={dest ?? suggestion}
                        setDestPath={(path) => setDest(path ?? '')}
                        switchable={false}
                        sourceOptions={{
                            label: t`Remote path`,
                            showPicker: true,
                            placeholder: t`Root path inside the remote`,
                            clearable: true,
                            allowedKeys: ['REMOTES', 'FAVORITES'],
                            showFiles: false,
                            remember: 'source',
                        }}
                        destOptions={{
                            label: t`Mount point`,
                            showPicker: true,
                            placeholder: windows
                                ? t`Next free drive letter`
                                : t`The local path to mount the remote to`,
                            clearable: true,
                            allowedKeys: ['LOCAL_FS', 'LOCAL_FS_EXTRA'],
                            showFiles: false,
                            problemOf: (path) =>
                                isDrive(path, windows) ? undefined : pathProblem(path),
                        }}
                        note={{
                            kind: 'info',
                            text: windows
                                ? t`A drive letter like M:, or empty for the next free one.`
                                : t`An empty folder. It is made if it is missing.`,
                        }}
                    />
                </section>

                <CacheMode
                    group={groups.vfs}
                    fallback={typeof appWideCache === 'string' ? appWideCache : undefined}
                />

                <OptionsSection items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    {...submission.footer}
                    line={mountLine(source, mountPoint ?? '')}
                    startedLine={mountedLine}
                    startedAction={{
                        label: t`Open`,
                        icon: <FolderIcon className="size-5" />,
                        onPress: openMount,
                    }}
                    startedExtra={
                        <Button
                            size="lg"
                            variant="flat"
                            color="danger"
                            onPress={unmount}
                            className="font-medium"
                            data-focus-visible="false"
                        >
                            <Trans>Unmount</Trans>
                        </Button>
                    }
                    newLabel={t`New mount`}
                    newButtonPrimary={false}
                    showViewTransfers={false}
                />
            </OperationWindowFooter>
        </OperationPage>
    )
}
