import { t } from '@lingui/core/macro'
import { useCallback, useMemo, useState } from 'react'
import type { OperationSubset } from '../../../lib/operations'
import { pathsFromArgs } from '../../../lib/rclone/templatePaths'
import { usePageStart, useReportEdited } from '../../route'
import OperationWindowContent, { OperationPage } from '../OperationWindowContent'
import OperationWindowFooter from '../OperationWindowFooter'
import {
    MultiPathFinder,
    PATH_PLACEHOLDER,
    PathFinder,
    type PathOptions,
    PICK_PLACEHOLDER,
    type RouteNote,
} from '../PathFinder'
import { askBeforeStart, syncQuestion } from './confirmations'
import { landingLine, useLandings } from './landings'
import OperationFooter from './OperationFooter'
import OperationHeader from './OperationHeader'
import { OptionsSection } from './OptionsAccordion'
import { pickerFor } from './places'
import { plainLine, transferLine } from './summary'
import { type OperationArgs, useOperationSubmission } from './useOperationSubmission'
import { remoteNamesOf, useOptionGroups } from './useOptionGroups'
import { useOptionItems } from './useOptionItems'

type Operation = OperationSubset<'copy' | 'move' | 'sync'>

const OPERATIONS: Record<
    Operation,
    {
        title: string
        intro: string
        started: string
        newLabel: string
        failed: string
        many: boolean
    }
> = {
    copy: {
        title: t`Copy`,
        intro: t`Copies files from the source to the destination. Files already there are skipped, and nothing is deleted.`,
        started: t`Copy started`,
        newLabel: t`New copy`,
        failed: t`Failed to start copy`,
        many: true,
    },
    move: {
        title: t`Move`,
        intro: t`Moves files from the source to the destination: each is copied, then removed from the source.`,
        started: t`Move started`,
        newLabel: t`New move`,
        failed: t`Failed to start move`,
        many: true,
    },
    sync: {
        title: t`Sync`,
        intro: t`Makes the destination match the source. Files are copied to the destination, and files that aren't in the source are deleted from it.`,
        started: t`Sync started`,
        newLabel: t`New sync`,
        failed: t`Failed to start sync`,
        many: false,
    },
}

function sourceOptions(operation: Operation): PathOptions {
    const picker = pickerFor(operation, 'source')
    return {
        label: t`Source`,
        showPicker: true,
        placeholder: PICK_PLACEHOLDER,
        clearable: true,
        showFiles: picker.files,
        allowedKeys: picker.allowedKeys,
        remember: picker.remember,
    }
}

function destOptions(operation: Operation): PathOptions {
    const picker = pickerFor(operation, 'destination')
    return {
        label: t`Destination`,
        showPicker: true,
        placeholder: PATH_PLACEHOLDER,
        clearable: true,
        showFiles: false,
        allowedKeys: picker.allowedKeys,
        remember: picker.remember,
    }
}

function routeNote(operation: Operation, landing: string | undefined): RouteNote | undefined {
    if (operation === 'sync') {
        return {
            kind: 'warning',
            text: t`The source's contents go straight in here. Files here that aren't in the source will be deleted.`,
        }
    }
    return landing ? { kind: 'lands', text: landing } : undefined
}

export default function TransferOperationPage({ operation }: { operation: Operation }) {
    const { title, intro, started, newLabel, failed, many } = OPERATIONS[operation]
    const start = usePageStart(operation)
    const presetArgs: OperationArgs | undefined = start.preset?.[operation] ?? undefined

    const [sources, setSources] = useState<string[] | undefined>(() => {
        if (many) return start.sources
        const source = start.sources?.[0]
        return source === undefined ? undefined : [source]
    })
    const [dest, setDest] = useState<string | undefined>(start.destination)
    const [opened] = useState({ sources, dest })
    const source = sources?.[0]
    const setSource = useCallback(
        (path: string | undefined) =>
            setSources((prev) =>
                prev?.[0] === path ? prev : path === undefined ? undefined : [path]
            ),
        []
    )

    const remoteNames = useMemo(() => remoteNamesOf([...(sources ?? []), dest]), [sources, dest])

    const optionState = useOptionGroups({
        operation,
        groups: [operation, 'filter', 'config', 'metadata'],
        remoteNames,
        initial: presetArgs?.options,
        initialRemotes: presetArgs?.options?.remotes,
    })
    const {
        jsonError,
        edited: optionsEdited,
        groups: optionGroups,
        remotes: remotesGroup,
        applyTemplate,
        getMergedOptions,
        resetJson,
    } = optionState
    const ownGroup = optionGroups[operation]
    const landings = useLandings(
        operation === 'move' ? 'move' : 'copy',
        operation === 'sync' ? undefined : sources,
        dest,
        remotesGroup.options
    )
    const landing = landingLine(landings, dest ?? '')
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config
    const metadataGroup = optionGroups.metadata

    const buildArgs = () => {
        const options = {
            config: configGroup.sent,
            metadata: metadataGroup.sent,
            [operation]: ownGroup.sent,
            filter: filterGroup.sent,
            remotes: remotesGroup.options,
        }
        return many
            ? { sources: sources ?? [], destination: dest ?? '', options }
            : { source: source ?? '', destination: dest ?? '', options }
    }

    const noSource = many ? !sources || sources.length === 0 : !source

    const submission = useOperationSubmission({
        operation,
        problem: () =>
            noSource
                ? t`Please select a source path`
                : dest
                  ? sources?.some((s) => s === dest)
                      ? t`Source and destination cannot be the same`
                      : undefined
                  : t`Please select a destination path`,
        jsonError,
        buildArgs,
        dryRun: true,
        confirm:
            operation === 'sync'
                ? (args) =>
                      askBeforeStart(syncQuestion(args.source ?? '', args.destination ?? ''), title)
                : undefined,
        error: {
            title,
            message: failed,
            log: [`Error starting ${operation}:`],
        },
        reset: {
            paths: () => {
                setSources(undefined)
                setDest(undefined)
            },
        },
        groups: { resetJson },
    })

    useReportEdited(
        !submission.startMutation.isSuccess &&
            (optionsEdited ||
                dest !== opened.dest ||
                (sources ?? []).join('\n') !== (opened.sources ?? []).join('\n'))
    )

    const accordionItems = useOptionItems(optionState, {
        refusals: submission.refusals,
        mapperPaths: { source, destination: dest },
    })

    const footer = submission.footer
    return (
        <OperationPage>
            <OperationWindowContent>
                {submission.scheduling}
                <OperationHeader
                    command={submission.command}
                    preview={submission.preview}
                    operation={operation}
                    intro={intro}
                    templates={{
                        isDisabled: submission.templatesDisabled,
                        onSelect: applyTemplate,
                        getOptions: getMergedOptions,
                        paths: {
                            get: () => pathsFromArgs({ sources, destination: dest }),
                            set: (paths) => {
                                const next = paths.sources ?? []
                                setSources(next.length === 0 ? undefined : many ? next : [next[0]])
                                setDest(paths.destination || undefined)
                            },
                        },
                    }}
                />

                {many ? (
                    <MultiPathFinder
                        sourcePaths={sources}
                        setSourcePaths={setSources}
                        destPath={dest}
                        setDestPath={setDest}
                        sourceOptions={sourceOptions(operation)}
                        destOptions={destOptions(operation)}
                        note={routeNote(operation, landing)}
                    />
                ) : (
                    <PathFinder
                        sourcePath={source}
                        setSourcePath={setSource}
                        destPath={dest}
                        setDestPath={setDest}
                        sourceOptions={sourceOptions(operation)}
                        destOptions={destOptions(operation)}
                        note={routeNote(operation, landing)}
                    />
                )}

                <OptionsSection items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    {...footer}
                    line={transferLine(operation, sources ?? [], dest)}
                    startedLine={plainLine(
                        started,
                        t`Follow it in History, where it can be stopped.`
                    )}
                    newLabel={newLabel}
                />
            </OperationWindowFooter>
        </OperationPage>
    )
}
