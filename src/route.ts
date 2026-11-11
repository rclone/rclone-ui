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
import { type RouteName, routeOf } from './routes'

// A page reads its query once, when it mounts: a source to start from, a preset, a transfer to
// show. A new route from the app remounts the page (useFollowedRoute), so that it reads the new
// query. A page that writes its own query (useSetPageQuery) marks that navigation as quiet, and
// stays mounted.

export function usePageQuery(): URLSearchParams {
    const [query] = useSearchParams()
    return query
}

/** The state of a navigation in which the page only wrote its own query (useSetPageQuery). */
const QUIET = { quiet: true } as const

function isQuiet(state: unknown): boolean {
    return typeof state === 'object' && state !== null && 'quiet' in state && state.quiet === true
}

/**
 * Returns a function that writes values into the page's query, or removes them (null), without
 * remounting the page. The address keeps what the page shows, so a reload opens it there again,
 * and a value that the page has read can be cleared. The history isn't added to.
 */
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

/** What a page starts with, from its query (startOf). */
export interface PageStart {
    /** The form that the page opens with (`?preset=`), as a transfer's Duplicate sends it. */
    preset?: OperationPreset
    /** The sources, or undefined when the route names none. */
    sources?: string[]
    destination?: string
    /** Download's link. */
    url?: string
}

/**
 * Reads what a page starts with from its query. A preset (`?preset=`) is read when it is a form
 * of `page`, or of any operation when no page is named. Its paths win over the query's own
 * parameters, which fill in what the preset leaves out: `initialSource` (once for each source,
 * as the launcher sends dropped files), `initialDestination` and `initialUrl`.
 */
export function startOf(query: URLSearchParams, page?: string): PageStart {
    const offered = decodePreset(query.get('preset'))
    const preset = offered && (!page || offered.operation === page) ? offered : undefined
    // Each form has only some of these fields.
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

/** What the page starts with (startOf), read once, when the page mounts. */
export function usePageStart(page: string): PageStart {
    const query = usePageQuery()
    const [start] = useState(() => startOf(query, page))
    return start
}

/**
 * Returns the path and query that an open window should navigate to when the app sends it a route
 * again, or null if the window should stay where it is. This happens for a launcher action, a tray
 * entry, another window's "Show transfer" or a deep link. A route without a query to the page that
 * the window already shows only focuses the window, whatever query the page was opened with. This
 * way, the launcher's "Copy" doesn't clear a Copy form that was opened with a source.
 */
export function routeToFollow(
    url: string,
    current: Pick<Location, 'href' | 'pathname'>
): string | null {
    const next = new URL(url, current.href)
    if (!next.search && next.pathname === current.pathname) return null
    return next.pathname + next.search
}

/**
 * Returns the title of the window that a route opens ("Sync" for "/sync?initialSource=…"). It is
 * the title of the "Replace what you entered…?" question.
 */
export function routeTitle(route: string): string {
    return routeOf(route).def?.look?.title ?? 'Rclone UI'
}

/**
 * Returns the question asked before a route replaces a form that was edited. It names what the
 * route opens, for example "Replace what you entered with Sync from gdrive:Photos to ~/Photos?".
 * The paths are the ones that the page starts with (startOf). Each window's question is a whole
 * message of its own, so that a language can name the window its own way.
 */
export function replaceQuestion(route: string): string {
    const url = new URL(route, 'wails://localhost')
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

/**
 * The question for a window that takes paths: Copy, Move, Sync and Bisync name their source and
 * destination, and the others their one path.
 */
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

/**
 * Holds whether the current page has a form that was edited. The page sets it through
 * useReportEdited, and FollowsQuery provides it.
 */
export const FormEdited = createContext<MutableRefObject<boolean> | null>(null)

/**
 * Reports whether the page's form was edited since the page opened and hasn't been started since.
 * FollowsQuery checks this before a new route replaces the page.
 */
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

/**
 * Returns the key of the route that the window's page shows, for FollowsQuery. It follows the
 * location, except when a new route arrives while the page's form is edited. In that case the user
 * is asked first ("Replace what you entered…?"). Replace follows the route, and Keep leaves the
 * page as it is. The page reports its edited state through `edited` (see FormEdited).
 */
export function useFollowedRoute() {
    const location = useLocation()
    const edited = useRef(false)
    const [shown, setShown] = useState(location.key)
    // The route that the user is being asked about. Each route is asked about once, and only the
    // answer for the latest route counts. A newer route closes the question about the older one.
    const asking = useRef<string | undefined>(undefined)
    const question = useRef<AbortController | null>(null)
    const route = location.pathname + location.search

    useEffect(() => {
        const key = location.key
        if (key === shown) return
        // The page wrote its own query, so it already shows what the address says.
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
            // If the question can't be shown, keep what was entered.
            .catch(() => false)
            .then((replace) => {
                if (asking.current !== key) return
                asking.current = undefined
                if (replace) setShown(key)
            })
    }, [location.key, location.state, route, shown])

    return { key: shown, edited }
}
