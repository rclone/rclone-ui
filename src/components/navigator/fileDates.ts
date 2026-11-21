// File dates. S3, Swift and a few other backends keep a file's date in metadata that a listing
// doesn't return. Reading it costs one request per file, so a large folder takes minutes to open.
// The core leaves those dates out (browse.List, Search and Compare), and the files show "—". The
// user can turn them on in the panel settings (the cog in `PlacesMenu`). Every other backend's
// dates come with the listing and always show.

import { usePref } from '../../../lib/prefs'

/** Whether the panels read the files' dates where each costs a request (off by default). */
export function useFileDates() {
    return usePref('fileDates')
}
