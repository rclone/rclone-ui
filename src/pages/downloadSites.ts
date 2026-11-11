import { plural, t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { links as api } from '../../lib/core/api'
import { coreKey } from '../../lib/core/query'
import { locale } from '../../lib/i18n'

// The sites whose pages the core can look up for the Download page (core/linkresolve). The URL
// field's description names them, but only the first few.

/** The sites that the link service knows. They don't change while the app runs. */
export function useLinkSites() {
    return useQuery({
        queryKey: coreKey('links', 'Sites'),
        queryFn: () => api.Sites(),
        staleTime: Number.POSITIVE_INFINITY,
    })
}

/**
 * Looks up the file on the page at `url`, through the link service. Cancel the returned promise
 * when the URL changes.
 */
export function resolveLink(url: string) {
    return api.Resolve(url)
}

/**
 * Why a lookup gave no file for a link to one of the sites (the core's linkresolve.Miss).
 * 'nothing' means the service found no file behind the page, which is also how it answers a
 * link that it can't read. 'unreachable' means the service gave no answer.
 */
export type LookupMiss = 'nothing' | 'unreachable'

/**
 * What a finished lookup missed. A link that isn't to one of the sites is never looked up: it
 * is a file's own address, so it misses nothing.
 */
export function missOf(link: {
    found: boolean
    miss: string
    filename: string
}): LookupMiss | undefined {
    if (link.found && link.filename) return undefined
    if (link.miss === 'unreachable') return 'unreachable'
    // A file without a name can't be saved as one, so it counts as not found.
    return link.miss === 'nothing' || link.found ? 'nothing' : undefined
}

/** The number of sites named before the rest are only counted. */
const NAMED = 4

function listOf(names: readonly string[]): string {
    return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(names)
}

export function sitesDescription(names: readonly string[]): string {
    if (names.length === 0) return t`A link to a file.`
    const named = names.slice(0, NAMED)
    const rest = names.length - named.length
    const more = t({
        message: plural(rest, { one: '# more', other: '# more' }),
        comment:
            'The last item of a list of website names, for the ones not named: "Instagram, TikTok, and 2 more".',
    })
    const sites = listOf(rest > 0 ? [...named, more] : named)
    return t`A link to a file or a page on ${sites}. Rclone UI detects the content behind it and downloads the video, audio or image.`
}
