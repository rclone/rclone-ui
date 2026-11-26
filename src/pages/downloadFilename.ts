import { t } from '@lingui/core/macro'
import { formatDate } from '../../lib/format'

const SEPARATOR = /[/\\]/

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

function decoded(segment: string) {
    try {
        const name = decodeURIComponent(segment)
        return filenameProblem(name) ? segment : name
    } catch {
        return segment
    }
}

export function fallbackFilename(url: string) {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').pop()
    return last ? decoded(last) : `${datedName(getUrlDomain(parsed))}.txt`
}

export function filenameProblem(filename: string) {
    if (!filename.trim()) return t`Please enter a filename`
    if (SEPARATOR.test(filename) || filename === '.' || filename === '..') {
        return t`A filename cannot contain / or \\`
    }
    return ''
}
