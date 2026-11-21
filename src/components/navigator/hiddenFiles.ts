// Hidden files. The panels hide the files and folders whose names start with a dot, as Finder and
// most file managers do. The user can show them in the panel settings (the cog in `PlacesMenu`).
// The listings, the folder sizes, the search (browse.Search) and Compare (browse.Compare) all
// follow it, in the Commander and in the file pickers.

import { usePref } from '../../../lib/prefs'

/** Whether the panels show the files and folders whose names start with a dot (off by default). */
export function useHiddenFiles() {
    return usePref('hiddenFiles')
}

/** Whether a panel shows an entry with this name. */
export function isShown(name: string, hidden: boolean): boolean {
    return hidden || !name.startsWith('.')
}
