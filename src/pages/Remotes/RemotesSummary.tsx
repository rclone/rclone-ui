import { cn } from '@heroui/react'
import { plural, t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { AngleRightSmall as AngleRightSmallIcon } from '@zappicon/react'
import { formatNumber } from '../../../lib/format'
import { Panel } from '../../components/look/Panel'
import { StatusDot, type StatusKind } from '../../components/look/Status'
import { TONE_GRADIENT } from '../../components/look/tones'
import { segments, stressed } from '../../components/operation/summary'
import { formatSize, listed, type Summary, spaceFree } from './usage'

/** How many remotes the legend names before it counts the rest. */
const LEGEND = 4

/**
 * The top of the Remotes window: how much the remotes store together, and what their checks
 * found. The counts of problems are buttons that show only those remotes.
 */
export function RemotesSummary({
    summary,
    onShowProblems,
}: {
    summary: Summary
    onShowProblems: () => void
}) {
    const { parts, used, free, reporting } = summary
    const capacity = used + free
    const rest = parts.length - LEGEND
    const checking = reporting === 0 && summary.checking > 0
    const usedSize = formatSize(used)
    const freeSize = formatSize(free)
    const silent = summary.silent

    return (
        <Panel className="grid grid-cols-[minmax(0,1fr)_auto]">
            <section
                aria-label={t({ message: 'Storage', comment: 'How much the remotes store.' })}
                className="flex flex-col min-w-0 gap-3 p-4 pe-5"
            >
                <div className="flex items-baseline gap-2 tabular-nums">
                    {reporting > 0 ? (
                        <>
                            <Trans comment='How much all the remotes store together: "640 GB used".'>
                                <span className="text-2xl font-semibold leading-none tracking-tight">
                                    {usedSize}
                                </span>{' '}
                                <span className="text-small text-default-500">used</span>
                            </Trans>
                            {free > 0 && (
                                <span className="ms-auto text-small text-default-500">
                                    {spaceFree(freeSize)}
                                </span>
                            )}
                        </>
                    ) : checking ? (
                        <span className="w-24 h-6 rounded-md bg-default-200/70 animate-pulse motion-reduce:animate-none" />
                    ) : (
                        <span className="text-small text-default-500">
                            <Trans>None of your remotes reports how much it stores.</Trans>
                        </span>
                    )}
                </div>

                <div
                    role="img"
                    aria-label={
                        reporting > 0
                            ? listed([
                                  ...parts.map((p) => partStores(p.remote, formatSize(p.used))),
                                  ...(free > 0 ? [spaceFree(freeSize)] : []),
                              ])
                            : t`No storage reported`
                    }
                    className={cn(
                        'flex h-2.5 overflow-hidden rounded-full bg-default-200/70 gap-0.5',
                        checking && 'animate-pulse motion-reduce:animate-none'
                    )}
                >
                    {capacity > 0 &&
                        parts.map((p) => (
                            <span
                                key={p.remote}
                                className={cn('h-full bg-linear-to-r', TONE_GRADIENT[p.tone])}
                                style={{ width: `${(p.used / capacity) * 100}%`, minWidth: 3 }}
                            />
                        ))}
                </div>

                {reporting > 0 && (
                    <ul className="flex flex-wrap items-center text-xs gap-x-4 gap-y-1 tabular-nums">
                        {parts.slice(0, LEGEND).map((p) => (
                            <li key={p.remote} className="flex items-center min-w-0 gap-1.5">
                                <span
                                    aria-hidden={true}
                                    className={cn(
                                        'size-2 rounded-full bg-linear-to-b shrink-0',
                                        TONE_GRADIENT[p.tone]
                                    )}
                                />
                                <span className="truncate max-w-32">{p.remote}</span>
                                <span className="text-default-500">{formatSize(p.used)}</span>
                            </li>
                        ))}
                        {rest > 0 && (
                            <li className="text-default-500">
                                {t({
                                    message: plural(rest, {
                                        one: 'and # more',
                                        other: 'and # more',
                                    }),
                                    comment:
                                        'After a list of remotes with their sizes: the remotes that are not listed.',
                                })}
                            </li>
                        )}
                        {silent > 0 && (
                            <li className="text-default-400 ms-auto">
                                {plural(silent, {
                                    one: '# remote doesn’t report its size',
                                    other: '# remotes don’t report their size',
                                })}
                            </li>
                        )}
                    </ul>
                )}
            </section>

            <section
                aria-label={t({
                    message: 'Status',
                    comment: 'What the checks of the remotes found.',
                })}
                className="flex flex-col justify-center gap-0.5 py-3 border-s border-divider w-56 px-2.5"
            >
                <Count kind="success" count={summary.connected} line={connectedLine} />
                <Count
                    kind="danger"
                    count={summary.failing}
                    line={failingLine}
                    onPress={onShowProblems}
                />
                <Count
                    kind="warning"
                    count={summary.noAnswer}
                    line={noAnswerLine}
                    onPress={onShowProblems}
                />
                <Count kind="active" count={summary.checking} line={checkingLine} />
            </section>
        </Panel>
    )
}

function partStores(remote: string, size: string): string {
    return t({
        message: `${remote} ${size}`,
        comment: 'A remote and how much it stores: "gdrive 12 GB".',
    })
}

// The sentences that `Count` shows, like "3 connected". `count` picks the plural form. `n` is the
// same number as text, formatted for the language and marked with `stressed`.

function connectedLine(count: number, n: string): string {
    return t({
        message: plural(count, { one: `${n} connected`, other: `${n} connected` }),
        comment: 'How many remotes are connected: "3 connected".',
    })
}

function failingLine(count: number, n: string): string {
    return t({
        message: plural(count, { one: `${n} can’t connect`, other: `${n} can’t connect` }),
        comment: 'How many remotes can’t connect to their storage: "2 can’t connect".',
    })
}

function noAnswerLine(count: number, n: string): string {
    return t({
        message: plural(count, { one: `${n} no answer`, other: `${n} no answer` }),
        comment: 'How many remotes gave no answer when they were checked: "1 no answer".',
    })
}

function checkingLine(count: number, n: string): string {
    return t({
        message: plural(count, { one: `${n} checking`, other: `${n} checking` }),
        comment: 'How many remotes are being checked now: "4 checking".',
    })
}

function Count({
    kind,
    count,
    line,
    onPress,
}: {
    kind: StatusKind
    count: number
    line: (count: number, n: string) => string
    onPress?: () => void
}) {
    if (count === 0) return null
    const content = (
        <>
            <StatusDot kind={kind} />
            {segments(line(count, stressed(formatNumber(count)))).map((part) =>
                part.strong ? (
                    <span key="count" className="font-semibold tabular-nums">
                        {part.text}
                    </span>
                ) : (
                    <span key={part.text} className="whitespace-nowrap text-default-600">
                        {part.text.trim()}
                    </span>
                )
            )}
        </>
    )
    const row = 'flex items-center gap-2 px-2 py-1 text-small rounded-lg'
    if (!onPress) return <p className={row}>{content}</p>
    return (
        <button
            type="button"
            onClick={onPress}
            className={cn(
                row,
                'text-left outline-none transition-colors duration-150 hover:bg-default-100 focus-visible:ring-2 focus-visible:ring-primary'
            )}
        >
            {content}
            <AngleRightSmallIcon className="size-4 ms-auto text-default-400" />
        </button>
    )
}
