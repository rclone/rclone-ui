// The filename that Download suggests for a link whose page has no file to find, and the check of
// a typed filename.

import { t } from '@lingui/core/macro'
import { formatDate } from '../../lib/format'

const SEPARATOR = /[/\\]/

/**
 * A name for a page that has none of its own: the site's name, the date and the time, as the
 * app's language writes them ("example 11-10-26 at 3.04.05 PM"). The characters that a filename
 * can't have are replaced.
 */
function datedName(site: string) {
    const now = new Date()
    const date = formatDate(now, { dateStyle: 'short' })
    const time = formatDate(now, { timeStyle: 'medium' })
    const name = t({
        message: `${site} ${date} at ${time}`,
        comment:
            'The suggested filename for a downloaded page: the site, the date and the time, as in "example 11-10-26 at 3.04.05 PM".',
    })
    return name.replace(/[/\\]/g, '-').replace(/:/g, '.')
}

function getUrlDomain(url: URL) {
    const hostname = url.hostname
    return hostname.split('.').slice(0, -1).join('.') || hostname.split('.')[0]
}

/** A segment decoded, unless it decodes to something that can't be a filename. */
function decoded(segment: string) {
    try {
        const name = decodeURIComponent(segment)
        return filenameProblem(name) ? segment : name
    } catch {
        return segment
    }
}

/**
 * The filename for the page at `url` itself: the last segment of its path, decoded. A path that
 * ends in `/` (or is empty) gives the site's name and the time.
 */
export function fallbackFilename(url: string) {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').pop()
    return last ? decoded(last) : `${datedName(getUrlDomain(parsed))}.txt`
}

/**
 * Returns why `filename` can't be the downloaded file's name, or '' when it can. It checks the
 * name as the core does (checkName in core/operations): the file is one entry of the destination,
 * not `a/b.mp4` or `..`.
 */
export function filenameProblem(filename: string) {
    if (!filename.trim()) return t`Please enter a filename`
    if (SEPARATOR.test(filename) || filename === '.' || filename === '..') {
        return t`A filename cannot contain / or \\`
    }
    return ''
}
