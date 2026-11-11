import type { OperationSubset } from '../../../lib/operations'
import type { AllowedKey } from '../navigator/types'
import type { PlaceKind } from '../pickerMemory'

// Each operation's path pickers. Every page reads its fields from here, so the pages offer the
// same places for the same kind of path.

export interface Picker {
    many: boolean
    files: boolean
    allowedKeys: AllowedKey[]
    /**
     * The field's kind for the picker's memory (pickerMemory.ts). A field that the operation reads
     * from is a source, and one that it writes to is a destination. Bisync's two folders and a
     * mount point are neither, so their pickers remember nothing.
     */
    remember?: PlaceKind
}

/** Every place: the disks, the home folder shortcuts, the remotes and the favorites. */
export const EVERYWHERE: AllowedKey[] = ['LOCAL_FS', 'LOCAL_FS_EXTRA', 'REMOTES', 'FAVORITES']
/** For what must be on a remote (a delete, a mount's source). */
export const REMOTES: AllowedKey[] = ['REMOTES', 'FAVORITES']
/** Only this computer: its disks and the home folder shortcuts (a mount point). */
export const THIS_MACHINE: AllowedKey[] = ['LOCAL_FS', 'LOCAL_FS_EXTRA']

const FOLDER: Picker = { many: false, files: false, allowedKeys: EVERYWHERE }
const FILES_OR_FOLDERS: Picker = { many: true, files: true, allowedKeys: EVERYWHERE }

export type PickerOperation = OperationSubset<
    'copy' | 'move' | 'sync' | 'bisync' | 'delete' | 'purge' | 'mount' | 'serve' | 'download'
>

/**
 * A download starts from a link, so it has no source. A delete, a purge and a serve have no
 * destination. Bisync works on two folders, never a file.
 */
export const PICKERS: Record<PickerOperation, { source?: Picker; destination?: Picker }> = {
    copy: {
        source: { ...FILES_OR_FOLDERS, remember: 'source' },
        destination: { ...FOLDER, remember: 'destination' },
    },
    move: {
        source: { ...FILES_OR_FOLDERS, remember: 'source' },
        destination: { ...FOLDER, remember: 'destination' },
    },
    sync: {
        source: { many: false, files: true, allowedKeys: EVERYWHERE, remember: 'source' },
        destination: { ...FOLDER, remember: 'destination' },
    },
    bisync: { source: FOLDER, destination: FOLDER },
    delete: { source: { many: true, files: true, allowedKeys: REMOTES, remember: 'source' } },
    purge: { source: { many: true, files: false, allowedKeys: REMOTES, remember: 'source' } },
    mount: {
        source: { many: false, files: false, allowedKeys: REMOTES, remember: 'source' },
        destination: { many: false, files: false, allowedKeys: THIS_MACHINE },
    },
    serve: { source: { ...FOLDER, remember: 'source' } },
    download: { destination: { ...FOLDER, remember: 'destination' } },
}

/** A field's picker. A field that the operation doesn't have offers folders anywhere. */
export function pickerFor(operation: PickerOperation, field: 'source' | 'destination'): Picker {
    return PICKERS[operation][field] ?? FOLDER
}
