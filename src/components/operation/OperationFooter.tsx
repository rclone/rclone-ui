import { Button, cn, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { AngleDownSmall as AngleDownSmallIcon, Clock as ClockIcon } from '@zappicon/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { type ReactNode, useCallback, useMemo, useRef } from 'react'
import { openWindow, platform } from '../../../lib/shell'
import { WINDOWS } from '../../routes'
import { toneButton } from '../look/buttons'
import { IconTile } from '../look/IconTile'
import { StatusDot } from '../look/Status'
import { pageLook } from './look'
import { type BarLine, plainLine } from './summary'

/** The animation that swaps the bar's buttons when the operation starts. */
export function useSwap() {
    const reduced = useReducedMotion()
    return {
        initial: { opacity: 0, scale: reduced ? 1 : 0.96 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: reduced ? 1 : 0.96 },
        transition: { type: 'spring', duration: 0.25, bounce: 0 },
    } as const
}

/**
 * The left of the action bar: what the main button will do, why it can't yet, or what has
 * started.
 */
export function BarText({
    line,
    problem,
    status,
}: {
    line?: BarLine
    /** Why the main button is disabled, shown instead of the line. */
    problem?: string
    status?: 'active' | 'success'
}) {
    return (
        <div className="flex items-center flex-1 min-w-0 gap-2.5 pl-2">
            {status && <StatusDot kind={status} />}
            <div className="flex flex-col min-w-0">
                {problem ? (
                    <p className="leading-snug truncate text-small text-default-500">{problem}</p>
                ) : line ? (
                    <>
                        <p className="leading-snug truncate text-small" title={textOf(line)}>
                            {line.title.map((segment, index) => (
                                <span
                                    // The segments never move, so the index is a safe key.
                                    key={index}
                                    className={
                                        segment.strong
                                            ? 'font-semibold text-foreground'
                                            : 'text-default-600'
                                    }
                                >
                                    {segment.text}
                                </span>
                            ))}
                        </p>
                        {line.detail && (
                            <p className="leading-snug truncate text-tiny text-default-500">
                                {line.detail}
                            </p>
                        )}
                    </>
                ) : null}
            </div>
        </div>
    )
}

function textOf(line: BarLine): string {
    return line.title.map((segment) => segment.text).join('')
}

export function StartButton({
    children,
    className,
    ...props
}: Parameters<typeof Button>[0] & { children: ReactNode }) {
    const { tone } = pageLook()
    return (
        <Button
            size="lg"
            type="button"
            color="primary"
            className={cn('gap-2 px-5 font-semibold min-w-36', toneButton(tone), className)}
            data-focus-visible="false"
            {...props}
        >
            {children}
        </Button>
    )
}

const previewStarting = () =>
    plainLine(
        t`Starting the preview…`,
        t`A dry run simulates the operation without changing anything.`
    )

/**
 * The action bar shared by the operation pages. On the left it says what will happen ("Sync
 * Photos to gdrive:Backup"), or why the page can't start yet. On the right are Schedule (on pages
 * that a schedule can run) and the main button. Once started, the bar says so, and offers the
 * next steps: History (or the page's own action, such as Serve's Copy address) and New, whose
 * menu resets the paths, the options or both.
 */
export default function OperationFooter({
    line,
    startedLine,
    problem,
    startIsSuccess,
    startIsPending,
    previewIsPending = false,
    onStart,
    onSchedule,
    startBlocked,
    buttonText,
    buttonIcon,
    newLabel,
    newButtonPrimary = true,
    showViewTransfers = true,
    startedAction,
    startedExtra,
    resetPathsLabel = t`Reset paths`,
    onResetPaths,
    onResetOptions,
    onResetAll,
}: {
    /** What the main button will do. */
    line?: BarLine
    /** What has started, once the main button has done it. */
    startedLine?: BarLine
    /** Why the main button is disabled, shown instead of `line`. */
    problem?: string
    startIsSuccess: boolean
    startIsPending: boolean
    /** A preview (a dry run) from the header's More menu is starting. The bar says so. */
    previewIsPending?: boolean
    /** Starts the operation. The button can be pressed again once the promise settles. */
    onStart: () => Promise<unknown> | undefined
    /** Opens the Schedule drawer with the page's form. Set on the pages that a schedule can run. */
    onSchedule?: () => void
    startBlocked: boolean
    buttonText: string
    buttonIcon: ReactNode
    newLabel: string
    newButtonPrimary?: boolean
    showViewTransfers?: boolean
    // Shown instead of View in History once started (the Serve page's Copy address).
    startedAction?: { label: string; onPress: () => void; icon?: ReactNode }
    /** More buttons once started, before New (the Mount page's Open and Unmount). */
    startedExtra?: ReactNode
    resetPathsLabel?: string
    onResetPaths: () => void
    onResetOptions: () => void
    onResetAll: () => void
}) {
    const dropdownShadow = useMemo(() => (platform() === 'windows' ? 'none' : undefined), [])
    const { tone } = pageLook()
    const swap = useSwap()

    // Set from the press until the start settles. The second press of a double-click arrives
    // before the page renders its pending state, and would start it twice.
    const running = useRef(false)
    const run = useCallback((action: (() => Promise<unknown> | undefined) | undefined) => {
        if (running.current || !action) {
            return
        }
        running.current = true
        setTimeout(async () => {
            try {
                await action()
            } finally {
                running.current = false
            }
        }, 100)
    }, [])

    const handleStartPress = useCallback(() => run(onStart), [run, onStart])

    const handleViewTransfersPress = useCallback(async () => {
        await openWindow('/history')
    }, [])

    const shown = startIsSuccess
        ? { line: startedLine, status: 'success' as const }
        : startIsPending
          ? { line, status: 'active' as const }
          : previewIsPending
            ? { line: previewStarting(), status: 'active' as const }
            : { line, problem: startBlocked ? problem : undefined }

    return (
        <>
            <BarText {...shown} />
            <AnimatePresence mode="wait" initial={false}>
                {startIsSuccess ? (
                    <motion.div key="started-buttons" {...swap} className="flex gap-2 shrink-0">
                        {startedExtra}
                        {startedAction ? (
                            // The page's own next step is the main one (Serve's Copy address,
                            // Mount's Open), in the window's tone.
                            <StartButton
                                startContent={startedAction.icon}
                                onPress={startedAction.onPress}
                                className="min-w-0"
                            >
                                {startedAction.label}
                            </StartButton>
                        ) : showViewTransfers ? (
                            <Button
                                size="lg"
                                variant="flat"
                                startContent={
                                    <IconTile
                                        icon={WINDOWS.history.icon}
                                        tone={WINDOWS.history.tone}
                                        size="sm"
                                    />
                                }
                                onPress={handleViewTransfersPress}
                                className="font-medium"
                                data-focus-visible="false"
                            >
                                <Trans>View in History</Trans>
                            </Button>
                        ) : null}
                        <Dropdown shadow={dropdownShadow} placement="top-end">
                            <DropdownTrigger>
                                <Button
                                    size="lg"
                                    color={newButtonPrimary ? 'primary' : undefined}
                                    variant={newButtonPrimary ? 'solid' : 'flat'}
                                    endContent={<AngleDownSmallIcon className="size-4" />}
                                    className={cn(
                                        'gap-1.5 font-semibold',
                                        newButtonPrimary && toneButton(tone)
                                    )}
                                    data-focus-visible="false"
                                >
                                    {newLabel}
                                </Button>
                            </DropdownTrigger>
                            <DropdownMenu aria-label={newLabel}>
                                <DropdownItem key="reset-paths" onPress={onResetPaths}>
                                    {resetPathsLabel}
                                </DropdownItem>
                                <DropdownItem key="reset-options" onPress={onResetOptions}>
                                    <Trans>Reset options</Trans>
                                </DropdownItem>
                                <DropdownItem key="reset-all" onPress={onResetAll}>
                                    <Trans>Reset all</Trans>
                                </DropdownItem>
                            </DropdownMenu>
                        </Dropdown>
                    </motion.div>
                ) : (
                    <motion.div key="start-button" {...swap} className="flex gap-2 shrink-0">
                        {onSchedule && (
                            <Button
                                size="lg"
                                type="button"
                                variant="flat"
                                isDisabled={startBlocked}
                                startContent={<ClockIcon className="size-5" />}
                                onPress={onSchedule}
                                aria-label={t`Schedule`}
                                className="gap-2 font-medium text-default-700 max-sm:min-w-12 max-sm:px-0"
                                data-focus-visible="false"
                            >
                                <span className="max-sm:hidden">
                                    <Trans>Schedule</Trans>
                                </span>
                            </Button>
                        )}
                        <StartButton
                            onPress={handleStartPress}
                            isDisabled={startIsPending || previewIsPending || startBlocked}
                            isLoading={startIsPending}
                            endContent={buttonIcon}
                        >
                            {buttonText}
                        </StartButton>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    )
}
