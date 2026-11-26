import { usePref } from '../../../lib/prefs'

export function useFileDates() {
    return usePref('fileDates')
}
