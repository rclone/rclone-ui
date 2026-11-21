import { t } from '@lingui/core/macro'
import { useState } from 'react'
import { pathsFromArgs } from '../../lib/rclone/templatePaths'
import OperationWindowContent, { OperationPage } from '../components/OperationWindowContent'
import OperationWindowFooter from '../components/OperationWindowFooter'
import { confirmPurge } from '../components/operation/confirmations'
import { pageLook } from '../components/operation/look'
import OperationFooter from '../components/operation/OperationFooter'
import OperationHeader from '../components/operation/OperationHeader'
import { OptionsSection } from '../components/operation/OptionsAccordion'
import { pickerFor } from '../components/operation/places'
import { plainLine, purgeLine } from '../components/operation/summary'
import { useOperationSubmission } from '../components/operation/useOperationSubmission'
import { useOptionGroups } from '../components/operation/useOptionGroups'
import { useOptionItems } from '../components/operation/useOptionItems'
import { MultiPathField, RoutePanel, RouteRow } from '../components/PathFinder'
import { usePageStart, useReportEdited } from '../route'

const PICKER = pickerFor('purge', 'source')

const DEFAULT_EXPANDED_KEYS = ['config']

export default function Purge() {
    const start = usePageStart('purge')
    const presetArgs = start.preset?.purge ?? undefined

    const [sources, setSources] = useState<string[] | undefined>(start.sources)
    const [openedWith] = useState(sources)

    const optionState = useOptionGroups({
        operation: 'purge',
        groups: ['config'],
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
    const configGroup = optionGroups.config

    const buildArgs = () => ({
        sources: sources ?? [],
        options: {
            config: configGroup.sent,
        },
    })

    const submission = useOperationSubmission({
        operation: 'purge',
        // The core refuses the root of a remote, and the page shows its refusal (useFormRefusal).
        problem: () => (sources && sources.length > 0 ? undefined : t`Please select a source path`),
        jsonError,
        buildArgs: buildArgs,
        dryRun: false,
        confirm: async (args) => ((await confirmPurge(args.sources ?? [])) ? 'start' : 'cancel'),
        error: {
            title: t({ message: 'Purge', comment: 'The name of the operation, as a title.' }),
            message: t`Failed to start purge`,
            log: ['[Purge] Failed to start purge:'],
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
    })

    const { tone } = pageLook()
    return (
        <OperationPage>
            <OperationWindowContent>
                {submission.scheduling}
                <OperationHeader
                    command={submission.command}
                    operation="purge"
                    intro={t`Deletes a folder and everything in it, in one go.`}
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
                    note={{
                        kind: 'danger',
                        text: t`This folder and everything in it will be deleted.`,
                    }}
                >
                    <RouteRow stop="single" tone={tone}>
                        <MultiPathField
                            paths={sources ?? []}
                            setPaths={setSources}
                            label={t`Folders`}
                            placeholder={t`Enter a remote:path to purge`}
                            showPicker={true}
                            allowedKeys={PICKER.allowedKeys}
                            showFiles={PICKER.files}
                            remember={PICKER.remember}
                            bare={true}
                        />
                    </RouteRow>
                </RoutePanel>

                <OptionsSection
                    defaultExpandedKeys={DEFAULT_EXPANDED_KEYS}
                    items={accordionItems}
                />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    {...submission.footer}
                    line={purgeLine(sources ?? [])}
                    startedLine={plainLine(t`Purge started`)}
                    newLabel={t`New purge`}
                    showViewTransfers={false}
                    resetPathsLabel={t`Reset path`}
                />
            </OperationWindowFooter>
        </OperationPage>
    )
}
