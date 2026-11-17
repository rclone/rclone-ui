import {
    Button,
    ButtonGroup,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownTrigger,
    Tooltip,
} from '@heroui/react'
import { platform } from '@tauri-apps/plugin-os'
import { AnimatePresence, motion } from 'framer-motion'
import { ClockIcon, EyeIcon } from 'lucide-react'
import { type ComponentProps, type ReactNode, useCallback, useMemo } from 'react'
import { useSchedulingAvailable } from '../../../lib/scheduler'
import { openWindow } from '../../../lib/window'
import type { Template } from '../../../types/template'
import CommandInfoButton from '../CommandInfoButton'
import CommandsDropdown from '../CommandsDropdown'
import TemplatesDropdown from '../TemplatesDropdown'

/**
 * The footer strip shared by the operation pages: TemplatesDropdown wiring, the AnimatePresence
 * START/NEW swap with the three reset items, and the ButtonGroup (dry-run when the page has one,
 * schedule, help, commands). Everything page-specific stays page-supplied: the reset onPress
 * bodies, the start/dry-run gating condition (`startBlocked` — the page's jsonError + path
 * checks), button text/icon, the NEW label, and the help prose.
 */
export default function OperationFooter({
    operation,
    templatesDisabled,
    onTemplateSelect,
    getTemplateOptions,
    startIsSuccess,
    startIsPending,
    onStart,
    onSchedule,
    dryRunIsPending,
    onDryRun,
    startBlocked,
    buttonText,
    buttonIcon,
    newLabel,
    newButtonPrimary = true,
    showViewTransfers = true,
    resetPathsLabel = 'Reset Paths',
    onResetPaths,
    onResetOptions,
    onResetAll,
    helpContent,
}: {
    operation: Template['tags'][number]
    templatesDisabled: boolean
    onTemplateSelect: ComponentProps<typeof TemplatesDropdown>['onSelect']
    getTemplateOptions: ComponentProps<typeof TemplatesDropdown>['getOptions']
    startIsSuccess: boolean
    startIsPending: boolean
    onStart: () => void
    onSchedule: () => void
    // Present only on pages with a dry-run mutation (Copy/Sync/Move/Delete).
    dryRunIsPending?: boolean
    onDryRun?: () => void
    startBlocked: boolean
    buttonText: string
    buttonIcon: ReactNode
    newLabel: string
    newButtonPrimary?: boolean
    showViewTransfers?: boolean
    resetPathsLabel?: string
    onResetPaths: () => void
    onResetOptions: () => void
    onResetAll: () => void
    helpContent: string
}) {
    const dropdownShadow = useMemo(() => (platform() === 'windows' ? 'none' : undefined), [])

    // Scheduling is OS-native and local-host-only; hide the affordance where it can't work
    // (sandboxed installs, remote hosts) — mirrors the Cron options section on the operation pages.
    const schedulingAvailable = useSchedulingAvailable()

    const handleStartPress = useCallback(() => {
        setTimeout(() => onStart(), 100)
    }, [onStart])

    const handleDryRunPress = useCallback(() => {
        if (dryRunIsPending || startBlocked) {
            return
        }
        setTimeout(() => onDryRun?.(), 100)
    }, [dryRunIsPending, startBlocked, onDryRun])

    const handleSchedulePress = useCallback(() => {
        setTimeout(() => onSchedule(), 100)
    }, [onSchedule])

    const handleViewTransfersPress = useCallback(async () => {
        await openWindow({
            name: 'Transfers',
            url: '/transfers',
        })
    }, [])

    return (
        <>
            <TemplatesDropdown
                isDisabled={templatesDisabled}
                operation={operation}
                onSelect={onTemplateSelect}
                getOptions={getTemplateOptions}
            />
            <AnimatePresence mode="wait" initial={false}>
                {startIsSuccess ? (
                    <motion.div
                        key="started-buttons"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="flex flex-1 gap-2"
                    >
                        <Dropdown shadow={dropdownShadow}>
                            <DropdownTrigger>
                                <Button
                                    fullWidth={true}
                                    size="lg"
                                    color={newButtonPrimary ? 'primary' : undefined}
                                    data-focus-visible="false"
                                >
                                    {newLabel}
                                </Button>
                            </DropdownTrigger>
                            <DropdownMenu>
                                <DropdownItem key="reset-paths" onPress={onResetPaths}>
                                    {resetPathsLabel}
                                </DropdownItem>
                                <DropdownItem key="reset-options" onPress={onResetOptions}>
                                    Reset Options
                                </DropdownItem>
                                <DropdownItem key="reset-all" onPress={onResetAll}>
                                    Reset All
                                </DropdownItem>
                            </DropdownMenu>
                        </Dropdown>

                        {showViewTransfers ? (
                            <Button
                                fullWidth={true}
                                size="lg"
                                color="secondary"
                                onPress={handleViewTransfersPress}
                                data-focus-visible="false"
                            >
                                VIEW TRANSFERS
                            </Button>
                        ) : null}
                    </motion.div>
                ) : (
                    <motion.div
                        key="start-button"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="flex flex-1"
                    >
                        <Button
                            onPress={handleStartPress}
                            size="lg"
                            fullWidth={true}
                            type="button"
                            color="primary"
                            isDisabled={startIsPending || startBlocked}
                            isLoading={startIsPending}
                            endContent={buttonIcon}
                            className="max-w-2xl gap-2"
                            data-focus-visible="false"
                        >
                            {buttonText}
                        </Button>
                    </motion.div>
                )}
            </AnimatePresence>
            <ButtonGroup variant="flat">
                {onDryRun ? (
                    <Tooltip
                        content="Preview (Dry Run)"
                        placement="top"
                        size="lg"
                        color="foreground"
                    >
                        <Button
                            size="lg"
                            type="button"
                            color="primary"
                            isIconOnly={true}
                            isLoading={dryRunIsPending}
                            onPress={handleDryRunPress}
                        >
                            <EyeIcon className="size-6" />
                        </Button>
                    </Tooltip>
                ) : null}
                {schedulingAvailable ? (
                    <Tooltip content="Schedule task" placement="top" size="lg" color="foreground">
                        <Button
                            size="lg"
                            type="button"
                            color="primary"
                            isIconOnly={true}
                            onPress={handleSchedulePress}
                        >
                            <ClockIcon className="size-6" />
                        </Button>
                    </Tooltip>
                ) : null}
                <CommandInfoButton content={helpContent} />
                <CommandsDropdown currentCommand={operation} />
            </ButtonGroup>
        </>
    )
}
