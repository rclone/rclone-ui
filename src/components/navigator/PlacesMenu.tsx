import {
    Button,
    Popover,
    PopoverContent,
    PopoverTrigger,
    ScrollShadow,
    Switch,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    Calendar as CalendarIcon,
    Gear as GearIcon,
    HardDrive as HardDriveIcon,
} from '@zappicon/react'
import { type ComponentType, useMemo } from 'react'
import { usePref } from '../../../lib/prefs'
import { IconTile } from '../look/IconTile'
import type { Tone } from '../look/tones'
import { useFileDates } from './fileDates'
import { useFolderSizes } from './folderSizes'
import useDisks from './useDisks'
import { getDiskIcon, getDiskLabel, shouldShowDisk } from './utils'

// The settings of the file panels: whether they measure folder sizes (`folderSizes.ts`), whether
// they read the slow file dates (`fileDates.ts`), and which shortcuts both sidebars show. The
// shortcuts are the local disks and folders that the core reports (`useDisks`), minus the ones
// turned off here. Those are stored in the `hiddenLocalPaths` preference.
export default function PlacesMenu() {
    const [hiddenLocalPaths, setHiddenLocalPaths] = usePref('hiddenLocalPaths')
    const setLocalPathHidden = (disk: string, hidden: boolean) =>
        setHiddenLocalPaths(
            hidden
                ? [...hiddenLocalPaths.filter((p) => p !== disk), disk]
                : hiddenLocalPaths.filter((p) => p !== disk)
        )
    const [folderSizes, setFolderSizes] = useFolderSizes()
    const [fileDates, setFileDates] = useFileDates()

    const allDisks = useDisks()
    const disks = useMemo(
        () =>
            (allDisks ?? []).filter((disk) => shouldShowDisk(disk, ['LOCAL_FS', 'LOCAL_FS_EXTRA'])),
        [allDisks]
    )

    return (
        <Popover placement="top-start" offset={10}>
            <Tooltip content={t`Panel settings`} size="sm" closeDelay={0}>
                {/* Clicking the bar's row toggles it open, so stop a click on the cog from
                    reaching the row. */}
                <div onClick={(event) => event.stopPropagation()}>
                    <PopoverTrigger>
                        <Button
                            isIconOnly={true}
                            size="sm"
                            variant="light"
                            radius="md"
                            aria-label={t`Panel settings`}
                            className="text-default-600"
                        >
                            <GearIcon className="size-4" />
                        </Button>
                    </PopoverTrigger>
                </div>
            </Tooltip>
            <PopoverContent
                aria-label={t`Panel settings`}
                className="items-stretch gap-0 p-0 overflow-hidden w-80 rounded-2xl"
            >
                <div className="flex flex-col divide-y divide-divider">
                    <SettingSwitch
                        id="setting-folder-sizes"
                        icon={HardDriveIcon}
                        tone="blue"
                        title={t`Local folder sizes`}
                        description={t`Measure each folder shown on this computer. Walking large folders takes a while.`}
                        isSelected={folderSizes}
                        onValueChange={setFolderSizes}
                    />
                    <SettingSwitch
                        id="setting-file-dates"
                        icon={CalendarIcon}
                        tone="orange"
                        title={t`File dates`}
                        description={t`For S3 and Swift. Each file's date needs a separate request, so large folders open slowly.`}
                        isSelected={fileDates}
                        onValueChange={setFileDates}
                    />
                </div>
                <div className="flex flex-col gap-0.5 px-4 pt-3 pb-1 border-t border-divider bg-default-50/60 dark:bg-default-50/30">
                    <p className="text-sm font-semibold">
                        {t({
                            message: 'Shortcuts',
                            comment:
                                'The disks and folders that the sidebars offer, not keyboard shortcuts.',
                        })}
                    </p>
                    <p className="text-xs text-default-500">
                        <Trans>Disks and folders both sidebars offer.</Trans>
                    </p>
                </div>
                <ScrollShadow className="flex flex-col px-4 pb-2 divide-y max-h-64 divide-divider bg-default-50/60 dark:bg-default-50/30">
                    {disks.map((disk, index) => {
                        const { icon, tone } = getDiskIcon(disk)
                        // HeroUI's Switch ignores `aria-label` when it has no children, so
                        // point to the name with aria-labelledby instead.
                        const labelId = `shortcut-${index}`
                        return (
                            <div key={disk} className="flex items-center gap-3 py-2">
                                <IconTile icon={icon} tone={tone} size="sm" />
                                <div className="flex flex-col flex-1 min-w-0">
                                    <span id={labelId} className="text-[13px] font-medium truncate">
                                        {getDiskLabel(disk)}
                                    </span>
                                    <span className="text-[11px] truncate text-default-500">
                                        {disk}
                                    </span>
                                </div>
                                <Switch
                                    size="sm"
                                    aria-labelledby={labelId}
                                    isSelected={!hiddenLocalPaths.includes(disk)}
                                    onValueChange={(shown) => setLocalPathHidden(disk, !shown)}
                                    classNames={{ wrapper: 'me-0' }}
                                />
                            </div>
                        )
                    })}
                    {disks.length === 0 && (
                        <p className="py-2 text-sm text-default-500">
                            {allDisks === undefined
                                ? t`Looking for disks…`
                                : t`No local disks found.`}
                        </p>
                    )}
                </ScrollShadow>
            </PopoverContent>
        </Popover>
    )
}

function SettingSwitch({
    id,
    icon,
    tone,
    title,
    description,
    isSelected,
    onValueChange,
}: {
    id: string
    icon: ComponentType<{ className?: string }>
    tone: Tone
    title: string
    description: string
    isSelected: boolean
    onValueChange: (value: boolean) => void
}) {
    return (
        <div className="flex items-start gap-3 px-4 py-3">
            <IconTile icon={icon} tone={tone} size="sm" className="mt-0.5" />
            <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                <span id={id} className="text-[13px] font-medium">
                    {title}
                </span>
                <span className="text-xs leading-snug text-default-500 text-pretty">
                    {description}
                </span>
            </div>
            <Switch
                size="sm"
                aria-labelledby={id}
                isSelected={isSelected}
                onValueChange={onValueChange}
                classNames={{ wrapper: 'me-0' }}
            />
        </div>
    )
}
