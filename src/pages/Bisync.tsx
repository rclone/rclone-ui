import { Switch } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMemo, useState } from 'react'
import type { Operations } from '../../lib/core/types'
import { coreError } from '../../lib/errors'
import { pathsFromArgs } from '../../lib/rclone/templatePaths'
import { ask } from '../../lib/shell'
import OperationWindowContent, { OperationPage } from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import { confirmBisync } from '../components/operation/confirmations'
import OperationFooter from '../components/operation/OperationFooter'
import OperationHeader from '../components/operation/OperationHeader'
import { OptionsSection } from '../components/operation/OptionsAccordion'
import { pickerFor } from '../components/operation/places'
import { bisyncLine, plainLine } from '../components/operation/summary'
import {
    type OperationArgs,
    useOperationSubmission,
} from '../components/operation/useOperationSubmission'
import { remoteNamesOf, useOptionGroups } from '../components/operation/useOptionGroups'
import { useOptionItems } from '../components/operation/useOptionItems'
import {
    PATH_PLACEHOLDER,
    PathFinder,
    type PathOptions,
    PICK_PLACEHOLDER,
} from '../components/PathFinder'
import { usePageStart, useReportEdited } from '../route'

// rclone refuses to bisync two folders when it has no listings from an earlier run, and asks for a
// resync instead. A resync copies files both ways so the folders match, and it sets the baseline
// that later runs compare against. The core reports the refusal as a precondition
// (`bisync_baseline`), and the page offers to run a resync.
const FIRST_RUN_QUESTION = t`Folder A and Folder B haven't been synced together yet. The first run sets a baseline: it copies files both ways so the two match, and deletes nothing.`

function withResync(args: OperationArgs): OperationArgs {
    return {
        ...args,
        options: { ...args.options, outer: { ...args.options?.outer, resync: true } },
    }
}

/** A switch that the Bisync section shows: one of bisync's own options that is on or off. */
type BisyncSwitch = {
    [K in keyof Operations.BisyncSwitches]-?: Operations.BisyncSwitches[K] extends
        | boolean
        | undefined
        ? K
        : never
}[keyof Operations.BisyncSwitches]

const BISYNC_SWITCHES = [
    {
        name: 'resync',
        help: t`Copies files both ways so the folders match. Used for the first run, or after an error.`,
    },
    {
        name: 'checkAccess',
        help: t`Runs only when both folders have an RCLONE_TEST file. This keeps a missing folder from being treated as deleted files.`,
    },
    {
        name: 'force',
        help: t`Runs even when more than half the files would be deleted.`,
    },
    { name: 'createEmptySrcDirs', help: t`Copies empty folders too.` },
    {
        name: 'removeEmptyDirs',
        help: t`Removes the folders that a run leaves empty. Can't be combined with createEmptySrcDirs.`,
    },
    {
        name: 'ignoreListingChecksum',
        help: t`Lists files without their checksums. Faster where checksums are slow to get.`,
    },
    {
        name: 'resilient',
        help: t`After a minor error, the next run tries again instead of needing a new baseline.`,
    },
    { name: 'noCleanup', help: t`Keeps the working files, to look into a problem.` },
] as const satisfies readonly { name: BisyncSwitch; help: string }[]

// Bisync has no source and destination, because changes go both ways between its two folders.
const FOLDER_A: PathOptions = {
    label: t`Folder A`,
    placeholder: PICK_PLACEHOLDER,
    showPicker: true,
    clearable: true,
    allowedKeys: pickerFor('bisync', 'source').allowedKeys,
    showFiles: false,
}

const FOLDER_B: PathOptions = {
    ...FOLDER_A,
    label: t`Folder B`,
    placeholder: PATH_PLACEHOLDER,
    allowedKeys: pickerFor('bisync', 'destination').allowedKeys,
}

export default function Bisync() {
    const start = usePageStart('bisync')
    const presetArgs = start.preset?.bisync ?? undefined

    const [source, setSource] = useState<string | undefined>(start.sources?.[0])
    const [dest, setDest] = useState<string | undefined>(start.destination)
    const [opened] = useState({ source, dest })

    // The remotes named in the two paths. Their option tabs are shown and their options are sent.
    // Text typed for other remotes is kept but not sent.
    const remoteNames = useMemo(() => remoteNamesOf([source, dest]), [source, dest])

    const optionState = useOptionGroups({
        operation: 'bisync',
        groups: ['bisync', 'filter', 'config', 'metadata'],
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
    const bisyncGroup = optionGroups.bisync
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config
    const metadataGroup = optionGroups.metadata

    // The switches from a reused run, without resync. A reused run is usually meant to run again
    // as normal, and resync stops deletions from syncing, so files deleted on one side come back.
    const [outerBisyncOptions, setOuterBisyncOptions] = useState<Operations.BisyncSwitches>(() => {
        const { resync: _, ...outer } = presetArgs?.options?.outer ?? {}
        return outer
    })
    const [openedSwitches] = useState(outerBisyncOptions)

    const buildStartArgs = () => ({
        source: source!,
        destination: dest!,
        options: {
            config: configGroup.sent,
            metadata: metadataGroup.sent,
            bisync: bisyncGroup.sent,
            filter: filterGroup.sent,
            remotes: remotesGroup.options,
            outer: outerBisyncOptions,
        },
    })

    const submission = useOperationSubmission({
        operation: 'bisync',
        problem: () =>
            source
                ? dest
                    ? source === dest
                        ? t`Folder A and Folder B cannot be the same`
                        : undefined
                    : t`Please select Folder B`
                : t`Please select Folder A`,
        jsonError,
        buildArgs: buildStartArgs,
        dryRun: false,
        // Bisync changes both sides, so ask before it starts, and say what resync and force do.
        confirm: async (args) =>
            (await confirmBisync(
                args.source ?? '',
                args.destination ?? '',
                args.options?.outer ?? undefined
            ))
                ? 'start'
                : 'cancel',
        retry: async (failure, args) => {
            if (coreError(failure)?.what !== 'bisync_baseline') return undefined
            const setBaseline = await ask(FIRST_RUN_QUESTION, {
                title: t({
                    message: 'First Run',
                    comment: 'Title of a question: the first bisync of two folders.',
                }),
                okLabel: t`Set a Baseline`,
                cancelLabel: t`Cancel`,
            })
            return setBaseline ? withResync(args) : false
        },
        error: {
            title: t({ message: 'Bisync', comment: 'The name of the operation, as a title.' }),
            message: t`Failed to start bisync operation`,
            log: ['Error starting bisync:'],
        },
        reset: {
            paths: () => {
                setSource(undefined)
                setDest(undefined)
            },
            extras: () => {
                setOuterBisyncOptions({})
            },
        },
        groups: { resetJson },
    })

    useReportEdited(
        !submission.startMutation.isSuccess &&
            (optionsEdited ||
                source !== opened.source ||
                dest !== opened.dest ||
                JSON.stringify(outerBisyncOptions) !== JSON.stringify(openedSwitches))
    )

    // The switches sit above the Bisync group's editor, and the ones that are on count as set,
    // with the group's options.
    const switches = useMemo(
        () => ({
            bisync: (
                <fieldset className="grid grid-cols-2 gap-2 pb-4">
                    <legend className="pb-2 font-medium text-small">
                        <Trans comment="Heading above bisync's on/off options.">Switches</Trans>
                    </legend>
                    {BISYNC_SWITCHES.map(({ name, help }) => (
                        <Switch
                            key={name}
                            isSelected={!!outerBisyncOptions[name]}
                            onValueChange={(value) =>
                                setOuterBisyncOptions({
                                    ...outerBisyncOptions,
                                    [name]: value,
                                })
                            }
                            size="sm"
                            classNames={{
                                base: 'inline-flex flex-row-reverse items-start justify-between w-full max-w-none gap-3 p-3 m-0 rounded-xl bg-default-100/60 transition-colors duration-150 data-[hover=true]:bg-default-100 dark:bg-default-100/40',
                                wrapper: 'me-0 mt-0.5 shrink-0',
                                label: 'flex flex-col gap-0.5 min-w-0',
                            }}
                        >
                            <span className="font-mono font-medium text-small">{name}</span>
                            <span className="leading-snug text-tiny text-default-500 text-pretty">
                                {help}
                            </span>
                        </Switch>
                    ))}
                </fieldset>
            ),
        }),
        [outerBisyncOptions]
    )
    const switchesOn = useMemo(
        () => ({
            bisync: Object.fromEntries(Object.entries(outerBisyncOptions).filter(([, on]) => on)),
        }),
        [outerBisyncOptions]
    )
    const accordionItems = useOptionItems(optionState, {
        refusals: submission.refusals,
        mapperPaths: { source, destination: dest },
        above: switches,
        counted: switchesOn,
    })

    return (
        <OperationPage>
            <OperationWindowContent>
                {submission.scheduling}
                <OperationHeader
                    command={submission.command}
                    operation="bisync"
                    intro={t`Keeps two places alike both ways: what changed on either side is copied to the other.`}
                    templates={{
                        isDisabled: submission.templatesDisabled,
                        onSelect: applyTemplate,
                        getOptions: getMergedOptions,
                        paths: {
                            get: () => pathsFromArgs({ source, destination: dest }),
                            set: (paths) => {
                                setSource(paths.sources?.[0] || undefined)
                                setDest(paths.destination || undefined)
                            },
                        },
                    }}
                />

                <PathFinder
                    sourcePath={source}
                    setSourcePath={setSource}
                    destPath={dest}
                    setDestPath={setDest}
                    sourceOptions={FOLDER_A}
                    destOptions={FOLDER_B}
                    bothWays={true}
                />

                <OptionsSection items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    {...submission.footer}
                    line={bisyncLine(source, dest)}
                    startedLine={plainLine(
                        t`Bisync started`,
                        t`Follow it in History, where it can be stopped.`
                    )}
                    newLabel={t`New bisync`}
                />
            </OperationWindowFooter>
        </OperationPage>
    )
}
