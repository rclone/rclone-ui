import { cn } from '@heroui/react'
import {
    ArrowLeftRightIcon,
    CopyIcon,
    DownloadIcon,
    FlameIcon,
    HardDriveIcon,
    MoveIcon,
    RefreshCwIcon,
    ServerIcon,
    Trash2Icon,
} from 'lucide-react'
import { Link } from 'react-router-dom'

export type OperationId =
    | 'copy'
    | 'move'
    | 'sync'
    | 'bisync'
    | 'download'
    | 'mount'
    | 'serve'
    | 'delete'
    | 'purge'

export const OPERATIONS: { id: OperationId; label: string; icon: typeof CopyIcon }[] = [
    { id: 'copy', label: 'Copy', icon: CopyIcon },
    { id: 'move', label: 'Move', icon: MoveIcon },
    { id: 'sync', label: 'Sync', icon: RefreshCwIcon },
    { id: 'bisync', label: 'Bisync', icon: ArrowLeftRightIcon },
    { id: 'download', label: 'Download', icon: DownloadIcon },
    { id: 'mount', label: 'Mount', icon: HardDriveIcon },
    { id: 'serve', label: 'Serve', icon: ServerIcon },
    { id: 'delete', label: 'Delete', icon: Trash2Icon },
    { id: 'purge', label: 'Purge', icon: FlameIcon },
]

const TILE =
    'flex flex-col items-center justify-center gap-2 py-4 text-xs rounded-xl outline-none border border-divider dark:border-neutral-800 text-foreground transition-colors hover:border-primary hover:text-primary focus-visible:ring-2 focus-visible:ring-primary'

/**
 * The rclone operations as a grid of tiles. On the desktop each opens its window; in a browser
 * tab it navigates. `only` narrows the set (a schedule can't be a mount or a serve).
 */
export default function OperationGrid({
    only,
    columns = 3,
    className,
}: {
    only?: OperationId[]
    columns?: 3 | 4 | 5
    className?: string
}) {
    const operations = only
        ? OPERATIONS.filter((operation) => only.includes(operation.id))
        : OPERATIONS
    const grid = { 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' }[columns]
    return (
        <div className={cn('grid gap-2', grid, className)}>
            {operations.map(({ id, label, icon: Icon }) =>
                    <Link key={id} to={`/${id}`} className={TILE}>
                        <Icon className="w-5 h-5" />
                        {label}
                    </Link>
            )}
        </div>
    )
}
