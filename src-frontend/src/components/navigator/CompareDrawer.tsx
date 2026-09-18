import {
    Button,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerHeader,
    Progress,
    ScrollShadow,
} from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircleIcon, XIcon } from 'lucide-react'
import { formatBytes } from '../../../lib/format.ts'
import FileIcon from './FileIcon'
import type { Entry, RemoteString } from './types'
import { listPath, serializeRemotePath } from './utils'

// A Commander panel's current location, as reported by FilePanel's onNavigate.
export type PanelLocation = { remote: RemoteString; path: string }

type CompareEntry = Entry & { hashes?: Record<string, string> }

// One row across the two columns; in the "only on" buckets exactly one side is present.
type ComparePair = { name: string; left?: CompareEntry; right?: CompareEntry }

const BUCKETS = [
    { key: 'onlyLeft', title: 'Only on left' },
    { key: 'onlyRight', title: 'Only on right' },
    { key: 'sameByName', title: 'Same by name' }, // on both sides, hashes missing or different
    { key: 'sameByHash', title: 'Same by hash' }, // on both sides, a shared hash type matches
] as const

type CompareResult = Record<(typeof BUCKETS)[number]['key'], ComparePair[]>

// Shallow listing with hashes, in the Commander's order (folders first, then by name) and without
// the hidden files the Commander hides too.
async function listEntries(loc: PanelLocation, signal: AbortSignal): Promise<CompareEntry[]> {
    const raw = await listPath(
        loc.remote as string,
        loc.path,
        { showHash: true, noModTime: false, noMimeType: true },
        signal
    )
    return raw
        .map((it): CompareEntry => {
            const rel = String(it.Path || it.Name || '')
            const name = rel.split('/').pop() ?? ''
            return {
                key: name,
                name,
                isDir: !!(it.IsDir || it.IsBucket),
                // rclone reports -1 when a backend doesn't know the size.
                size: typeof it.Size === 'number' && it.Size >= 0 ? it.Size : undefined,
                modTime: it.ModTime,
                hashes: it.Hashes && typeof it.Hashes === 'object' ? it.Hashes : undefined,
                fullPath: rel,
            }
        })
        .filter((e) => e.name && !e.name.startsWith('.'))
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

// True when any hash type both sides report carries an equal, non-empty digest. Backends with no
// hashes (or no algorithm in common) never match, so those pairs land in "same by name" — by design.
function hashesMatch(a?: Record<string, string>, b?: Record<string, string>): boolean {
    if (!a || !b) return false
    return Object.entries(a).some(
        ([type, digest]) => !!digest && digest.toLowerCase() === b[type]?.toLowerCase()
    )
}

// Both inputs are sorted, so every bucket comes out sorted without a second pass.
function diff(left: CompareEntry[], right: CompareEntry[]): CompareResult {
    const result: CompareResult = { onlyLeft: [], onlyRight: [], sameByName: [], sameByHash: [] }
    const rightByName = new Map(right.map((e) => [e.name, e]))
    const leftNames = new Set(left.map((e) => e.name))

    for (const l of left) {
        const r = rightByName.get(l.name)
        if (r) {
            const bucket = hashesMatch(l.hashes, r.hashes) ? result.sameByHash : result.sameByName
            bucket.push({ name: l.name, left: l, right: r })
        } else {
            result.onlyLeft.push({ name: l.name, left: l })
        }
    }
    for (const r of right) {
        if (!leftNames.has(r.name)) result.onlyRight.push({ name: r.name, right: r })
    }
    return result
}

function locationLabel(loc: PanelLocation | null): string {
    if (!loc) return ''
    if (loc.remote === 'UI_LOCAL_FS') return loc.path || '/'
    return serializeRemotePath(loc.remote ?? '', loc.path)
}

// One cell in a section column. A missing entry (the empty side of an "only on" row) renders an
// equal-height spacer so the left and right columns stay aligned row-for-row.
function CompareRow({ entry }: { entry?: CompareEntry }) {
    if (!entry) return <div className="h-11 border-b border-divider last:border-b-0" />
    return (
        <div className="flex items-center h-11 gap-2 px-3 border-b border-divider last:border-b-0">
            <FileIcon entry={entry} size="md" />
            <span className="flex-1 text-sm truncate" title={entry.fullPath}>
                {entry.name}
            </span>
            <span className="text-xs text-default-400 shrink-0">
                {entry.isDir ? '' : entry.size === undefined ? '—' : formatBytes(entry.size)}
            </span>
        </div>
    )
}

function CompareSection({ title, pairs }: { title: string; pairs: ComparePair[] }) {
    if (pairs.length === 0) return null
    return (
        <section className="mt-4 first:mt-0">
            <div className="sticky top-0 z-10 flex items-center gap-2 py-2 bg-content1/90 backdrop-blur-sm">
                <h3 className="text-sm font-semibold">{title}</h3>
                <span className="rounded-full bg-default-100 px-2 py-0.5 text-xs text-default-500">
                    {pairs.length}
                </span>
            </div>
            <div className="grid grid-cols-2 overflow-hidden border rounded-lg gap-px border-divider bg-divider">
                <div className="bg-content1">
                    {pairs.map((p) => (
                        <CompareRow key={p.name} entry={p.left} />
                    ))}
                </div>
                <div className="bg-content1">
                    {pairs.map((p) => (
                        <CompareRow key={p.name} entry={p.right} />
                    ))}
                </div>
            </div>
        </section>
    )
}

// Mounted only while the drawer is open, so the listings run (and are cancelled through the query
// signal) with the drawer, and gcTime 0 makes every open a fresh comparison.
function CompareView({
    left,
    right,
    onClose,
}: {
    left: PanelLocation | null
    right: PanelLocation | null
    onClose: () => void
}) {
    const { data, isLoading, error } = useQuery({
        queryKey: ['compare', left, right],
        enabled: !!left && !!right,
        gcTime: 0,
        refetchOnWindowFocus: false,
        queryFn: async ({ signal }) => {
            const [l, r] = await Promise.all([
                listEntries(left!, signal),
                listEntries(right!, signal),
            ])
            return diff(l, r)
        },
    })
    const isEmpty = !!data && BUCKETS.every((b) => data[b.key].length === 0)

    return (
        <>
            <DrawerHeader className="flex flex-col gap-2 border-b border-divider">
                <div className="flex items-center justify-between">
                    <span className="text-base font-semibold">Compare</span>
                    <Button isIconOnly={true} size="sm" variant="light" onPress={onClose}>
                        <XIcon className="size-4" />
                    </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs font-normal text-default-500">
                    {[left, right].map((loc, i) => {
                        const label = locationLabel(loc)
                        return (
                            <span
                                key={i === 0 ? 'left' : 'right'}
                                className="truncate"
                                title={label}
                            >
                                {label}
                            </span>
                        )
                    })}
                </div>
            </DrawerHeader>
            <DrawerBody className="p-0">
                {isLoading ? (
                    <div className="flex items-center justify-center h-full">
                        <Progress
                            isIndeterminate={true}
                            aria-label="Comparing directories"
                            className="max-w-xs"
                        />
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2 text-danger">
                        <AlertCircleIcon className="size-6" />
                        <span className="text-sm">{error.message}</span>
                    </div>
                ) : isEmpty ? (
                    <div className="flex items-center justify-center h-full text-sm text-default-400">
                        Nothing to compare — both folders are empty.
                    </div>
                ) : data ? (
                    <ScrollShadow className="h-full px-4 pb-6">
                        {BUCKETS.map((b) => (
                            <CompareSection key={b.key} title={b.title} pairs={data[b.key]} />
                        ))}
                    </ScrollShadow>
                ) : null}
            </DrawerBody>
        </>
    )
}

export default function CompareDrawer({
    isOpen,
    onClose,
    left,
    right,
}: {
    isOpen: boolean
    onClose: () => void
    left: PanelLocation | null
    right: PanelLocation | null
}) {
    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={onClose}
            hideCloseButton={true}
        >
            <DrawerContent className="bg-content1/80 backdrop-blur-md dark:bg-content1/90">
                {() => <CompareView left={left} right={right} onClose={onClose} />}
            </DrawerContent>
        </Drawer>
    )
}
