import { plural, t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import { links as api } from '../../lib/core/api'
import { coreKey } from '../../lib/core/query'
import { locale } from '../../lib/i18n'

export function useLinkSites() {
    return useQuery({
        queryKey: coreKey('links', 'Sites'),
        queryFn: () => api.Sites(),
        staleTime: Number.POSITIVE_INFINITY,
    })
}

export function resolveLink(url: string) {
    return api.Resolve(url)
}

export type LookupMiss = 'nothing' | 'unreachable'

export function missOf(link: {
    found: boolean
    miss: string
    filename: string
}): LookupMiss | undefined {
    if (link.found && link.filename) return undefined
    if (link.miss === 'unreachable') return 'unreachable'
    return link.miss === 'nothing' || link.found ? 'nothing' : undefined
}

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
