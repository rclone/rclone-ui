import {
    Button,
    Popover,
    PopoverContent,
    PopoverTrigger,
    ScrollShadow,
    Switch,
    Tooltip,
    cn,
} from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { SettingsIcon } from 'lucide-react'
import { useMemo } from 'react'
import rclone from '@/lib/rclone/client'
import { usePersistedStore } from '@/store'
import { getDiskIcon, getDiskLabel, shouldShowDisk } from './utils'

// The shortcuts both file panels keep in their sidebars: the local disks and folders rclone
// reports, minus the ones turned off here. The query is the sidebars' own, so it is already
// answered by the time the menu opens.
export default function PlacesMenu() {
    const hiddenLocalPaths = usePersistedStore((state) => state.hiddenLocalPaths)
    const setLocalPathHidden = usePersistedStore((state) => state.setLocalPathHidden)

    const disksQuery = useQuery({
        queryKey: ['core', 'disks'],
        queryFn: () => rclone('/core/disks'),
        staleTime: 1000 * 60 * 5,
    })
    const disks = useMemo(
        () =>
            ((disksQuery.data?.disks ?? []) as string[]).filter((disk) =>
                shouldShowDisk(disk, ['LOCAL_FS', 'LOCAL_FS_EXTRA'])
            ),
        [disksQuery.data]
    )

    return (
        <Popover placement="top-start" offset={8}>
            <Tooltip content="Shortcuts" size="sm">
                {/* The bar's own row toggles it open; a click on the cog is the cog's alone. */}
                <div onClick={(event) => event.stopPropagation()}>
                    <PopoverTrigger>
                        <Button isIconOnly={true} size="sm" variant="light" aria-label="Shortcuts">
                            <SettingsIcon className="size-4" />
                        </Button>
                    </PopoverTrigger>
                </div>
            </Tooltip>
            <PopoverContent aria-label="Shortcuts" className="items-stretch w-72 gap-1 p-3">
                <p className="text-sm font-medium">Shortcuts</p>
                <p className="pb-1 text-xs text-default-500">
                    Disks and folders both sidebars offer.
                </p>
                <ScrollShadow className="flex flex-col divide-y max-h-72 divide-divider">
                    {disks.map((disk, index) => {
                        const { icon: DiskIcon, className: iconColor } = getDiskIcon(disk)
                        // HeroUI's Switch drops `aria-label` when it has no children; point at
                        // the name instead.
                        const labelId = `shortcut-${index}`
                        return (
                            <div key={disk} className="flex items-center gap-3 py-2">
                                <DiskIcon className={cn('size-5 shrink-0', iconColor)} />
                                <div className="flex flex-col flex-1 min-w-0">
                                    <span id={labelId} className="text-sm font-medium truncate">
                                        {getDiskLabel(disk)}
                                    </span>
                                    <span className="text-xs truncate text-default-500">
                                        {disk}
                                    </span>
                                </div>
                                <Switch
                                    size="sm"
                                    aria-labelledby={labelId}
                                    isSelected={!hiddenLocalPaths.includes(disk)}
                                    onValueChange={(shown) => setLocalPathHidden(disk, !shown)}
                                />
                            </div>
                        )
                    })}
                    {disks.length === 0 && (
                        <p className="py-2 text-sm text-default-500">
                            {disksQuery.isPending ? 'Looking for disks…' : 'No local disks found.'}
                        </p>
                    )}
                </ScrollShadow>
            </PopoverContent>
        </Popover>
    )
}
