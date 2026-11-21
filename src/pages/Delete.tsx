import { Link } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMemo, useState } from 'react'
import { onErrorDialog } from '../../lib/errors'
import { getRemoteName } from '../../lib/format'
import { pathsFromArgs } from '../../lib/rclone/templatePaths'
import { hasFeature, useFsInfo } from '../../lib/remotes'
import { openWindow } from '../../lib/shell'
import OperationWindowContent, { OperationPage } from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import { confirmDelete, hasFilters } from '../components/operation/confirmations'
import { pageLook } from '../components/operation/look'
import OperationFooter from '../components/operation/OperationFooter'
import OperationHeader from '../components/operation/OperationHeader'
import { OptionsSection } from '../components/operation/OptionsAccordion'
import { pickerFor } from '../components/operation/places'
import { deleteLine, plainLine } from '../components/operation/summary'
import { useOperationSubmission } from '../components/operation/useOperationSubmission'
import { useOptionGroups } from '../components/operation/useOptionGroups'
import { useOptionItems } from '../components/operation/useOptionItems'
import { MultiPathField, RoutePanel, RouteRow } from '../components/PathFinder'
import { usePageStart, useReportEdited } from '../route'

const PICKER = pickerFor('delete', 'source')

export default function Delete() {
    const start = usePageStart('delete')
    const presetArgs = start.preset?.delete ?? undefined

    const [sources, setSources] = useState<string[] | undefined>(start.sources)
    const [openedWith] = useState(sources)

    const optionState = useOptionGroups({
        operation: 'delete',
        groups: ['filter', 'config', 'metadata'],
        initial: presetArgs?.options,
    })
    const {
        jsonError,
        edited: optionsEdited,
        groups: optionGroups,
        applyTemplate,
        getMergedOptions,
        resetJson,
    } = optionState
    const filterGroup = optionGroups.filter
    const configGroup = optionGroups.config
    const metadataGroup = optionGroups.metadata

    // The tip names one remote, so it is only shown for one path.
    const sourceRemoteName = useMemo(
        () => (sources?.length === 1 ? getRemoteName(sources[0]) : null),
        [sources]
    )

    const sourceFsInfoQuery = useFsInfo(sourceRemoteName)

    // False while the remote's features load, so the plain delete is offered until purge is
    // known to be supported.
    const supportsPurge = useMemo(
        () => !!sourceRemoteName && hasFeature(sourceFsInfoQuery.data, 'Purge'),
        [sourceRemoteName, sourceFsInfoQuery.data]
    )

    const buildArgs = () => ({
        sources: sources ?? [],
        options: {
            filter: filterGroup.sent,
            config: configGroup.sent,
            metadata: metadataGroup.sent,
        },
    })

    const submission = useOperationSubmission({
        operation: 'delete',
        // The core refuses the root of a remote, and the page shows its refusal (useFormRefusal).
        problem: () => (sources && sources.length > 0 ? undefined : t`Please select a source path`),
        jsonError,
        buildArgs: buildArgs,
        dryRun: true,
        // With filters, only the matching files are deleted, and the question says so.
        confirm: async (args) =>
            (await confirmDelete(
                args.sources ?? [],
                hasFilters(filterGroup.options, metadataGroup.options)
            ))
                ? 'start'
                : 'cancel',
        error: {
            title: t({ message: 'Delete', comment: 'The name of the operation, as a title.' }),
            message: t`Failed to start delete`,
            log: ['Error starting delete:'],
        },
        reset: {
            paths: () => {
                setSources(undefined)
            },
        },
        groups: { resetJson },
    })

    useReportEdited(
        !submission.startMutation.isSuccess &&
            (optionsEdited || (sources ?? []).join('\n') !== (openedWith ?? []).join('\n'))
    )

    const accordionItems = useOptionItems(optionState, {
        refusals: submission.refusals,
        mapperPaths: { source: sources?.[0] },
    })

    const { tone } = pageLook()
    const firstSource = sources?.[0]
    return (
        <OperationPage>
            <OperationWindowContent>
                {submission.scheduling}
                <OperationHeader
                    command={submission.command}
                    preview={submission.preview}
                    operation="delete"
                    intro={t`Deletes the files in the paths you pick, and keeps their folders.`}
                    templates={{
                        isDisabled: submission.templatesDisabled,
                        onSelect: applyTemplate,
                        getOptions: getMergedOptions,
                        paths: {
                            get: () => pathsFromArgs({ sources }),
                            set: (paths) =>
                                setSources(paths.sources?.length ? paths.sources : undefined),
                        },
                    }}
                />

                <RoutePanel
                    tone={tone}
                    note={
                        supportsPurge && firstSource
                            ? {
                                  kind: 'info',
                                  text: (
                                      <Trans>
                                          Deleting a whole folder? {sourceRemoteName} can purge it
                                          instead, in one call rather than one for each file.{' '}
                                          <Link
                                              as="button"
                                              type="button"
                                              size="sm"
                                              underline="always"
                                              className="align-baseline"
                                              onPress={() =>
                                                  openWindow(
                                                      `/purge?initialSource=${encodeURIComponent(firstSource)}`
                                                  ).catch(onErrorDialog(t`Couldn't open Purge`))
                                              }
                                          >
                                              Purge it instead
                                          </Link>
                                      </Trans>
                                  ),
                              }
                            : undefined
                    }
                >
                    <RouteRow stop="single" tone={tone}>
                        <MultiPathField
                            paths={sources ?? []}
                            setPaths={setSources}
                            label={t`Files or folders`}
                            placeholder={t`Enter a remote:path to delete`}
                            showPicker={true}
                            allowedKeys={PICKER.allowedKeys}
                            showFiles={PICKER.files}
                            remember={PICKER.remember}
                            bare={true}
                        />
                    </RouteRow>
                </RoutePanel>

                <OptionsSection items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    {...submission.footer}
                    line={deleteLine(
                        sources ?? [],
                        hasFilters(filterGroup.options, metadataGroup.options)
                    )}
                    startedLine={plainLine(t`Delete started`)}
                    newLabel={t`New delete`}
                    showViewTransfers={false}
                    resetPathsLabel={t`Reset path`}
                />
            </OperationWindowFooter>
        </OperationPage>
    )
}
