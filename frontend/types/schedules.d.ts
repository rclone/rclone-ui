import type {
    BisyncArgs,
    CopyArgs,
    DeleteArgs,
    MoveArgs,
    PurgeArgs,
    SyncArgs,
} from '../lib/rclone/requests'

export type ScheduledTask = {
    id: string
    name?: string
    cron: string
    isEnabled: boolean
    /**
     * Max run time in whole hours (1-120); the run stops its transfer when it's exceeded.
     * Default 24 when absent.
     */
    maxRunHours?: number
    /**
     * Set when the last registration attempt failed (an unparseable cron, a write that did not
     * land). Persisted so a disabled task can explain itself across restarts.
     */
    registrationError?: string
    /**
     * What each source is, file or folder, as rclone answered when the task was saved: its
     * job file is built from this, and rebuilt from it without asking again.
     */
    kinds?: Record<string, 'file' | 'folder'>
} & (
    | {
          operation: 'delete'
          args: DeleteArgs
      }
    | {
          operation: 'sync'
          args: SyncArgs
      }
    | {
          operation: 'copy'
          args: CopyArgs
      }
    | {
          operation: 'move'
          args: MoveArgs
      }
    | {
          operation: 'purge'
          args: PurgeArgs
      }
    | {
          operation: 'bisync'
          args: BisyncArgs
      }
)
