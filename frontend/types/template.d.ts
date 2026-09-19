import type { FlagValue } from './rclone'

/** Where a template's operation runs: a list because copy/move/delete/purge take several. */
export interface TemplatePaths {
    sources?: string[]
    destination?: string
}

export interface Template {
    id: string
    name: string
    tags: ('copy' | 'sync' | 'move' | 'delete' | 'purge' | 'serve' | 'mount' | 'bisync')[]
    options: Record<string, FlagValue>
    /** Absent when the page it was saved from had none. */
    paths?: TemplatePaths
}
