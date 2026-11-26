import { plural, t } from '@lingui/core/macro'
import {
    createContext,
    type MutableRefObject,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import type { Operations } from '../lib/core/types'
import { formArgs } from '../lib/operations'
import { ask } from '../lib/shell'
import { decodePreset, type OperationPreset } from '../lib/transfers/preset'
import { ROUTE_BASE, type RouteName, routeOf } from './routes'

export function usePageQuery(): URLSearchParams {
    const [query] = useSearchParams()
    return query
}

const QUIET = { quiet: true } as const

function isQuiet(state: unknown): boolean {
    return typeof state === 'object' && state !== null && 'quiet' in state && state.quiet === true
}

export function useSetPageQuery(): (values: Record<string, string | null>) => void {
    const navigate = useNavigate()
    return useCallback(
        (values) => {
            const url = new URL(window.location.href)
            const before = url.searchParams.toString()
            for (const [name, value] of Object.entries(values)) {
                if (value === null) url.searchParams.delete(name)
                else url.searchParams.set(name, value)
            }
            if (url.searchParams.toString() === before) return
            navigate(url.pathname + url.search + url.hash, { replace: true, state: QUIET })
        },
        [navigate]
    )
}

export interface PageStart {
    preset?: OperationPreset
    sources?: string[]
    destination?: string
    url?: string
}

export function startOf(query: URLSearchParams, page?: string): PageStart {
    const offered = decodePreset(query.get('preset'))
    const preset = offered && (!page || offered.operation === page) ? offered : undefined
    const args = formArgs(preset) as
        | Partial<Operations.CopyArgs & Operations.SyncArgs & Operations.DownloadArgs>
        | undefined
    const initial = query.getAll('initialSource')
    return {
        preset,
        sources:
            args?.sources ??
            (args?.source === undefined ? undefined : [args.source]) ??
            (initial.length > 0 ? initial : undefined),
        destination: args?.destination ?? query.get('initialDestination') ?? undefined,
        url: args?.url ?? query.get('initialUrl') ?? undefined,
    }
}

export function usePageStart(page: string): PageStart {
    const query = usePageQuery()
    const [start] = useState(() => startOf(query, page))
    return start
}

export function routeToFollow(
    url: string,
    current: Pick<Location, 'href' | 'pathname'>
): string | null {
    const next = new URL(url, current.href)
    if (!next.search && next.pathname === current.pathname) return null
    return next.pathname + next.search
}

export function routeTitle(route: string): string {
    return routeOf(route).def?.look?.title ?? 'Rclone UI'
}

export function replaceQuestion(route: string): string {
    const url = new URL(route, ROUTE_BASE)
    const { name, def } = routeOf(route)
    if (!name || !def?.form) return t`Replace what you entered?`
    const start = startOf(url.searchParams, name)
    const sources = (start.sources ?? []).filter(Boolean)
    const [first] = sources
    const source =
        sources.length > 1
            ? plural(sources.length - 1, {
                  one: `${first} and # more`,
                  other: `${first} and # more`,
              })
            : first
    const { destination, url: link } = start
    return replaceWith(name, source, destination, link || source || destination)
}

function replaceWith(
    name: RouteName,
    source: string | undefined,
    destination: string | undefined,
    path: string | undefined
): string {
    switch (name) {
        case 'sync':
            if (source && destination)
                return t`Replace what you entered with Sync from ${source} to ${destination}?`
            if (source) return t`Replace what you entered with Sync from ${source}?`
            if (destination) return t`Replace what you entered with Sync to ${destination}?`
            return t`Replace what you entered with a new Sync?`
        case 'copy':
            if (source && destination)
                return t`Replace what you entered with Copy from ${source} to ${destination}?`
            if (source) return t`Replace what you entered with Copy from ${source}?`
            if (destination) return t`Replace what you entered with Copy to ${destination}?`
            return t`Replace what you entered with a new Copy?`
        case 'move':
            if (source && destination)
                return t`Replace what you entered with Move from ${source} to ${destination}?`
            if (source) return t`Replace what you entered with Move from ${source}?`
            if (destination) return t`Replace what you entered with Move to ${destination}?`
            return t`Replace what you entered with a new Move?`
        case 'bisync':
            if (source && destination)
                return t`Replace what you entered with Bisync from ${source} to ${destination}?`
            if (source) return t`Replace what you entered with Bisync from ${source}?`
            if (destination) return t`Replace what you entered with Bisync to ${destination}?`
            return t`Replace what you entered with a new Bisync?`
        case 'delete':
            return path
                ? t`Replace what you entered with Delete of ${path}?`
                : t`Replace what you entered with a new Delete?`
        case 'purge':
            return path
                ? t`Replace what you entered with Purge of ${path}?`
                : t`Replace what you entered with a new Purge?`
        case 'download':
            return path
                ? t`Replace what you entered with Download of ${path}?`
                : t`Replace what you entered with a new Download?`
        case 'serve':
            return path
                ? t`Replace what you entered with Serve of ${path}?`
                : t`Replace what you entered with a new Serve?`
        case 'mount':
            return path
                ? t`Replace what you entered with Mount of ${path}?`
                : t`Replace what you entered with a new Mount?`
        default:
            return t`Replace what you entered?`
    }
}

export const FormEdited = createContext<MutableRefObject<boolean> | null>(null)

export function useReportEdited(edited: boolean) {
    const report = useContext(FormEdited)
    useEffect(() => {
        if (!report) return
        report.current = edited
        return () => {
            report.current = false
        }
    }, [report, edited])
}

export function useFollowedRoute() {
    const location = useLocation()
    const edited = useRef(false)
    const [shown, setShown] = useState(location.key)
    const asking = useRef<string | undefined>(undefined)
    const question = useRef<AbortController | null>(null)
    const route = location.pathname + location.search

    useEffect(() => {
        const key = location.key
        if (key === shown) return
        if (isQuiet(location.state)) return
        if (!edited.current) {
            asking.current = undefined
            setShown(key)
            return
        }
        if (asking.current === key) return
        asking.current = key
        question.current?.abort()
        question.current = new AbortController()
        ask(replaceQuestion(route), {
            title: routeTitle(route),
            okLabel: t({
                message: 'Replace',
                comment: 'Button: replaces the form with the new one.',
            }),
            cancelLabel: t({
                message: 'Keep',
                comment: 'Button: keeps what was entered in the form.',
            }),
            signal: question.current.signal,
        })
            .catch(() => false)
            .then((replace) => {
                if (asking.current !== key) return
                asking.current = undefined
                if (replace) setShown(key)
            })
    }, [location.key, location.state, route, shown])

    return { key: shown, edited }
}
