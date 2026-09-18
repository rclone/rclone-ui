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
    /** The config file this task runs with (a lookup into the host's configFiles). */
    configId: string
    /** 'app-default' or an absolute path to a specific rclone binary. */
    binaryPath: 'app-default' | string
    /** Raise the run's rclone daemon to INFO logging (per-transfer lines in the rclone log). */
    verboseLogging?: boolean
    /**
     * Max run time in whole hours (1-120); the runner stops the job when it's exceeded.
     * Default 24 when absent.
     */
    maxRunHours?: number
    /**
     * 'user' (default, also when absent): only runs while the user is logged in, borrowing the
     * session's context. 'system': runs even while logged out, but outside the login session —
     * no OS keychain, session-mounted drives, or (macOS) protected folders without a cron FDA
     * grant.
     */
    runMode?: 'system' | 'user'
    /**
     * Set when the last OS-registration attempt failed (cron unrepresentable on this platform,
     * register error). Persisted so a disabled task can explain itself across restarts.
     */
    registrationError?: string
    /**
     * What each source is, file or folder, as rclone answered when the task was saved: its
     * job file is built from this, and rebuilt from it without asking again. A task saved
     * before this field falls back to the spelling of its paths.
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
