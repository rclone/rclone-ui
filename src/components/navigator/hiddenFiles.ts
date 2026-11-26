import { usePref } from '../../../lib/prefs'

export function useHiddenFiles() {
    return usePref('hiddenFiles')
}

export function isShown(name: string, hidden: boolean): boolean {
    return hidden || !name.startsWith('.')
}
