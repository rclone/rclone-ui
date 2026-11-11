import { cn, Radio, RadioGroup } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Clipboard as ClipboardIcon } from '@zappicon/react'
import { useId, useState } from 'react'
import { useFlags } from '../../../lib/catalog'
import { reportError } from '../../../lib/errors'
import { pathsFromArgs } from '../../../lib/rclone/templatePaths'
import { message } from '../../../lib/shell'
import { IconTile } from '../../components/look/IconTile'
import { SURFACE } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import OperationWindowContent, { OperationPage } from '../../components/OperationWindowContent'
import OperationWindowFooter from '../../components/OperationWindowFooter'
import { pageLook } from '../../components/operation/look'
import OperationFooter from '../../components/operation/OperationFooter'
import OperationHeader, { rcloneDocsUrl } from '../../components/operation/OperationHeader'
import { OptionsSection } from '../../components/operation/OptionsAccordion'
import {
    type BarLine,
    placeWords,
    segments,
    serveLine,
    sourcesWords,
} from '../../components/operation/summary'
import { useOperationSubmission } from '../../components/operation/useOperationSubmission'
import { useOptionGroups } from '../../components/operation/useOptionGroups'
import { useOptionItems } from '../../components/operation/useOptionItems'
import { PathField, RoutePanel, RouteRow } from '../../components/PathFinder'
import { usePageQuery, usePageStart, useReportEdited } from '../../route'
import { carryOptions } from './carryOptions'
import { protocolIcon, protocolName } from './protocols'
import { copyServeAddress, ServeList } from './running'
import ServeSettings from './ServeSettings'
import { ServeFailedError, startServe, useServes } from './serves'

const TYPE_HELP: Record<string, string> = {
    http: t`Browse and download files in a web browser`,
    webdav: t`Open it in Finder, File Explorer and file managers`,
    ftp: t`Connect with any FTP app`,
    sftp: t`Connect with any SFTP app, over SSH`,
    dlna: t`Play media on TVs and players on your network`,
    s3: t`Connect with apps and tools that use S3`,
    nfs: t`Mount it from other computers`,
    restic: t`Back up to it with restic`,
}

/** The bar's sentence: what the button will serve, and over what. Without a type, "a protocol". */
function lineOf(source: string | undefined, type: string | undefined): BarLine {
    if (type) return serveLine(source, protocolName(type))
    const what = sourcesWords([source])
    return { title: segments(t`Serve ${what} over a protocol`) }
}

function servedLine(addr: string, type: string): BarLine {
    const address = placeWords(addr)
    const protocol = protocolName(type)
    return {
        title: segments(t`Serving at ${address}`),
        detail: t`Over ${protocol}, until it is stopped.`,
    }
}

// The serve's cyan (look/tones.ts), for the ring of the picked protocol.
const PICKED =
    'data-[selected=true]:shadow-[0_0_0_2px_rgb(6_182_212),0_6px_16px_-6px_rgb(6_182_212/0.45)]'

export default function Serve() {
    const query = usePageQuery()
    const start = usePageStart('serve')
    const presetArgs = start.preset?.serve ?? undefined
    // The serve types available on this computer, from the catalog (nfs is Unix only).
    const { serveTypes, serveFlags } = useFlags()

    const [source, setSource] = useState<string | undefined>(start.sources?.[0])
    const [type, setType] = useState<string | undefined>(
        () => presetArgs?.type ?? query.get('initialType') ?? undefined
    )
    const [opened] = useState({ source, type })

    const optionState = useOptionGroups({
        operation: 'serve',
        groups: ['serve', 'vfs', 'filter', 'config', 'metadata'],
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

    const submission = useOperationSubmission({
        operation: 'serve',
        start: startServe,
        problem: () => {
            if (!source) return t`Please select a source`
            if (!type) return t`Please select a serve type`
            return undefined
        },
        jsonError,
        // buildArgs runs only after `problem` passes, so the source and the type are set.
        buildArgs: () => ({
            type: type ?? '',
            source: source ?? '',
            options: {
                serve: groups.serve.sent,
                vfs: groups.vfs.sent,
                filter: groups.filter.sent,
                config: groups.config.sent,
                metadata: groups.metadata.sent,
            },
        }),
        error: async (failure) => {
            if (failure instanceof ServeFailedError) {
                await message(failure.message, { title: t`The serve failed`, kind: 'error' })
                return
            }
            console.error('[Serve] Failed to start serve:', failure)
            await reportError(failure, {
                title: t({ message: 'Serve', comment: 'The name of the operation, as a title.' }),
                fallback: t`Failed to start serve`,
            })
        },
        reset: {
            paths: () => {
                setSource(undefined)
                setType(undefined)
            },
        },
        groups: { resetJson },
    })
    const served = submission.startMutation.data

    useReportEdited(!served && (optionsEdited || source !== opened.source || type !== opened.type))

    // The serve group offers the options of the picked type, and shows only once one is picked.
    const optionItems = useOptionItems(optionState, {
        refusals: submission.refusals,
        // The served source is where the mapper's fields come from and go to.
        mapperPaths: { destination: source },
        serveType: type,
    })
    const accordionItems = type ? optionItems : optionItems.filter((item) => item.key !== 'serve')

    const { tone } = pageLook()
    const protocolId = useId()
    const pickType = (next: string | undefined) => {
        // Keep the options that the new type also has, with their values. Options that only the
        // old type has would be rejected.
        if (next !== type) {
            const kept = next ? carryOptions(groups.serve.options, serveFlags[next] ?? []) : {}
            groups.serve.setJsonString(
                Object.keys(kept).length > 0 ? JSON.stringify(kept, null, 2) : '{}'
            )
        }
        setType(next)
    }
    const serves = useServes()

    return (
        <OperationPage>
            <OperationWindowContent>
                <OperationHeader
                    command={submission.command}
                    operation="serve"
                    intro={t`Shares a folder over the network, so other devices and apps can open its files.`}
                    docs={rcloneDocsUrl(type ? `serve_${type}` : 'serve')}
                    templates={{
                        isDisabled: submission.templatesDisabled,
                        // The core puts the options of this serve type in the serve group.
                        serveType: type,
                        onSelect: applyTemplate,
                        getOptions: getMergedOptions,
                        paths: {
                            // A serve has no destination.
                            get: () => pathsFromArgs({ source }),
                            set: (paths) => setSource(paths.sources?.[0] || undefined),
                        },
                    }}
                />

                <ServeList />

                <section aria-label={t`New serve`} className="flex flex-col gap-3">
                    {serves.length > 0 && <SectionTitle className="px-1" title={t`New serve`} />}
                    <RoutePanel tone={tone}>
                        <RouteRow stop="single" tone={tone}>
                            <PathField
                                path={source || ''}
                                setPath={setSource}
                                label={t`Folder`}
                                placeholder={t`Enter a remote:/path, or click to choose a folder`}
                                showPicker={true}
                                showFiles={false}
                                remember="source"
                                bare={true}
                            />
                        </RouteRow>
                    </RoutePanel>
                </section>

                <section className="flex flex-col gap-3">
                    <SectionTitle
                        id={protocolId}
                        className="px-1"
                        title={t({
                            message: 'Type',
                            comment:
                                'Heading above the kinds of server to pick from (HTTP, WebDAV, FTP…).',
                        })}
                    />
                    <RadioGroup
                        aria-labelledby={protocolId}
                        orientation="horizontal"
                        size="sm"
                        value={type ?? ''}
                        onValueChange={(next) => pickType(next || undefined)}
                        classNames={{ wrapper: 'grid grid-cols-2 gap-3' }}
                    >
                        {serveTypes.map((kind) => (
                            <Radio
                                key={kind}
                                value={kind}
                                classNames={{
                                    base: cn(
                                        SURFACE,
                                        'm-0 max-w-none w-full flex-row-reverse justify-between items-start gap-3 p-3 transition-shadow duration-150',
                                        PICKED
                                    ),
                                    wrapper:
                                        'mt-0.5 group-data-[selected=true]:border-cyan-500 dark:group-data-[selected=true]:border-cyan-400',
                                    control: 'bg-cyan-500 dark:bg-cyan-400',
                                    labelWrapper: 'ms-0 flex-1 min-w-0',
                                }}
                            >
                                <span className="flex items-center gap-3">
                                    <IconTile icon={protocolIcon(kind)} tone={tone} size="lg" />
                                    <span className="flex flex-col min-w-0">
                                        <span className="font-semibold text-small">
                                            {protocolName(kind)}
                                        </span>
                                        <span className="leading-snug text-tiny text-default-500 text-pretty">
                                            {TYPE_HELP[kind]}
                                        </span>
                                    </span>
                                </span>
                            </Radio>
                        ))}
                    </RadioGroup>
                </section>

                {type && <ServeSettings group={groups.serve} options={serveFlags[type] ?? []} />}

                <OptionsSection items={accordionItems} />
            </OperationWindowContent>

            <OperationWindowFooter>
                <OperationFooter
                    {...submission.footer}
                    line={lineOf(source, type)}
                    startedLine={served ? servedLine(served.addr, served.type) : undefined}
                    newLabel={t`New serve`}
                    newButtonPrimary={false}
                    showViewTransfers={false}
                    startedAction={
                        served
                            ? {
                                  label: t`Copy address`,
                                  icon: <ClipboardIcon className="size-5" />,
                                  onPress: () => copyServeAddress(served),
                              }
                            : undefined
                    }
                    resetPathsLabel={t`Reset folder and protocol`}
                />
            </OperationWindowFooter>
        </OperationPage>
    )
}
