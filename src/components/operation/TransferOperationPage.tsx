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

// The differences between Copy, Move and Sync: their text, and whether they accept several
// sources. Each line that names the operation is a whole message of its own.
const OPERATIONS: Record<
    Operation,
    {
        title: string
        /** The sentence under the page's title. */
        intro: string
        /** The action bar's line after the start. */
        started: string
        /** The button that gets the page ready for another run. */
        newLabel: string
        /** What the error dialog says when the failure has no message of its own. */
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

/** It has no description: where the sources land is said under the route (routeNote). */
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

/**
 * The line under the route. Copy's and Move's says where the sources land, because each one goes
 * inside the destination under its own name (see landings.ts). Sync's says that the source's
 * contents go straight in, and keeps the deletions in view.
 */
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
    // The preset's arguments. Sync's form has a source, and Copy's and Move's have sources.
    const presetArgs: OperationArgs | undefined = start.preset?.[operation] ?? undefined

    // Sync's single source is stored as a list with one item. An empty string is kept as it is,
    // and the page asks the user to select a source.
    const [sources, setSources] = useState<string[] | undefined>(() => {
        if (many) return start.sources
        const source = start.sources?.[0]
        return source === undefined ? undefined : [source]
    })
    const [dest, setDest] = useState<string | undefined>(start.destination)
    // The paths the page opened with. If they change, the form counts as edited.
    const [opened] = useState({ sources, dest })
    const source = sources?.[0]
    // Setting the same path keeps the same list, so React skips the re-render as it would for a
    // string.
    const setSource = useCallback(
        (path: string | undefined) =>
            setSources((prev) =>
                prev?.[0] === path ? prev : path === undefined ? undefined : [path]
            ),
        []
    )

    // The remotes named by the paths. Their tabs are parsed and sent. Text in other remotes' tabs
    // is kept but not sent.
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
    // Sync has no landings: its source's contents always go straight into the destination.
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

    // buildArgs only runs after `problem` has passed, so the paths are set.
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

    // Copy and Move need a non-empty list. Sync needs a source that isn't ''.
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
        // Sync deletes files that are only in the destination, so ask before it starts.
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
