import type { OperationSubset } from '../../../lib/operations'
import type { AllowedKey } from '../navigator/types'
import type { PlaceKind } from '../pickerMemory'

export interface Picker {
    many: boolean
    files: boolean
    allowedKeys: AllowedKey[]
    remember?: PlaceKind
}

export const EVERYWHERE: AllowedKey[] = ['LOCAL_FS', 'LOCAL_FS_EXTRA', 'REMOTES', 'FAVORITES']
export const REMOTES: AllowedKey[] = ['REMOTES', 'FAVORITES']
export const THIS_MACHINE: AllowedKey[] = ['LOCAL_FS', 'LOCAL_FS_EXTRA']

const FOLDER: Picker = { many: false, files: false, allowedKeys: EVERYWHERE }
const FILES_OR_FOLDERS: Picker = { many: true, files: true, allowedKeys: EVERYWHERE }

export type PickerOperation = OperationSubset<
    'copy' | 'move' | 'sync' | 'bisync' | 'delete' | 'purge' | 'mount' | 'serve' | 'download'
>

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

export function pickerFor(operation: PickerOperation, field: 'source' | 'destination'): Picker {
    return PICKERS[operation][field] ?? FOLDER
}
