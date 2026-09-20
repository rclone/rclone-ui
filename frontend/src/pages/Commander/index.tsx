import { useQuery } from '@tanstack/react-query'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useSearchParams } from 'react-router-dom'
import { reportError } from '@/lib/errors'
import { getFsInfo } from '@/lib/format'
import { parsePath } from '@/lib/paths'
import { notify } from '@/lib/notifications'
import { startBatch } from '@/lib/rclone/start'
import { UserCancelledError } from '@/lib/errors'
import rclone from '@/lib/rclone/client'

import { BatchRenameDrawer, CompareDrawer, FilePanel, type FilePanelHandle, type PanelLocation, useEntryActions } from '@/components/navigator'
import type { Entry, SelectItem } from '@/components/navigator/types'
import { writeText } from '@/clipboard'
import { saveAs } from '@/dialog'
import { usePersistedStore } from '@/store'
import OperationDialog from './OperationDialog'
import TransfersBar from './TransfersBar'

/** `?path=remote:dir` targets a remote (rclone's own reading of it); anything else is local. */
function parsePanelTarget(raw: string | null): { remote: string; path: string } | null {
    if (!raw) return null
    const parsed = parsePath(raw)
    if (parsed.kind === 'remote') return { remote: parsed.name, path: parsed.path }
    return { remote: 'UI_LOCAL_FS', path: raw }
}

export default function Browser() {
    const leftPanelRef = useRef<FilePanelHandle>(null)
    const rightPanelRef = useRef<FilePanelHandle>(null)

    // The Dashboard's getting-started step for this page: being here is doing it. Under the
    // Shell the store is hydrated before any page mounts, so the write is never overtaken.
    useEffect(() => {
        const { onboarding, completeOnboardingStep } = usePersistedStore.getState()
        if (!onboarding.completed.includes('commander')) completeOnboardingStep('commander')
    }, [])

    const [dropOperation, setDropOperation] = useState<{
        items: SelectItem[]
        destination: string
    } | null>(null)

    // The transfers this page started, by the record's id for them (its bar shows these).
    const [trackedIds, setTrackedIds] = useState<Set<string>>(new Set())

    const handleJobStarted = useCallback((id: string) => {
        setTrackedIds((prev) => new Set([...prev, id]))
    }, [])

    const refreshPanels = useCallback(() => {
        leftPanelRef.current?.refresh()
        rightPanelRef.current?.refresh()
    }, [])

    // Where each panel is and what it has selected, for the Compare / Batch Rename actions.
    const [leftLoc, setLeftLoc] = useState<PanelLocation | null>(null)
    const [rightLoc, setRightLoc] = useState<PanelLocation | null>(null)
    const handleLeftNavigate = useCallback((remote: string, path: string) => {
        setLeftLoc({ remote, path })
    }, [])
    const handleRightNavigate = useCallback((remote: string, path: string) => {
        setRightLoc({ remote, path })
    }, [])
    const [leftSel, setLeftSel] = useState<SelectItem[]>([])
    const [rightSel, setRightSel] = useState<SelectItem[]>([])

    const [compareOpen, setCompareOpen] = useState(false)
    const compareDisabledReason = [leftLoc, rightLoc].every(
        (loc) => loc?.remote && loc.remote !== 'UI_FAVORITES'
    )
        ? undefined
        : 'Open a folder in both panels to compare.'

    // Batch Rename needs a selection of at least 2 items in exactly one panel. The items are
    // snapshotted on open so the drawer keeps them through its closing animation.
    const renameSel = leftSel.length > 0 ? leftSel : rightSel
    const renameDisabledReason =
        leftSel.length > 0 && rightSel.length > 0
            ? 'Select items in only one panel to batch rename.'
            : renameSel.length < 2
              ? 'Select at least 2 items in one panel to batch rename.'
              : undefined
    const [batchRenameOpen, setBatchRenameOpen] = useState(false)
    const [batchRenameItems, setBatchRenameItems] = useState<SelectItem[]>([])
    const handleOpenBatchRename = useCallback(() => {
        setBatchRenameItems(renameSel)
        setBatchRenameOpen(true)
    }, [renameSel])

    // Renamed entries have new keys, so the old selection is stale either way.
    const handleBatchRenameDone = useCallback(() => {
        for (const ref of [leftPanelRef, rightPanelRef]) {
            ref.current?.refresh()
            ref.current?.clearSelection()
        }
    }, [])

    const remotesQuery = useQuery({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => await rclone('/config/listremotes').then((r) => r?.remotes),
        staleTime: 1000 * 60,
    })

    const remotes = remotesQuery.data ?? []
    const firstRemote = remotes[0] ?? null

    const [searchParams] = useSearchParams()
    const rawTarget = searchParams.get('path')
    const rightPanelTarget = useMemo(() => parsePanelTarget(rawTarget), [rawTarget])
    // The first target seeds the right panel; later ones (the browser sidebar's remotes while
    // the Commander is already open) move it.
    const initialRightTarget = useRef(rightPanelTarget)
    useEffect(() => {
        if (rightPanelTarget && rightPanelTarget !== initialRightTarget.current) {
            rightPanelRef.current?.navigate(rightPanelTarget.remote, rightPanelTarget.path)
        }
    }, [rightPanelTarget])
    const handleDrop = useCallback(
        (items: SelectItem[], destination: string, _sourceSide: 'left' | 'right') => {
            setDropOperation({ items, destination })
        },
        []
    )

    const handleDownload = useCallback(
        async (entry: Entry) => {
            const defaultName = entry.name
            const savePath = await saveAs({
                title: `Save ${entry.isDir ? 'Folder' : 'File'}`,
                defaultPath: defaultName,
            })

            if (!savePath) return

            const srcInfo = getFsInfo(entry.fullPath)
            const dstInfo = getFsInfo(savePath)

            const srcFs = srcInfo.root
            const srcRemote = srcInfo.filePath
            const dstFs = dstInfo.root
            const dstRemote = dstInfo.filePath

            try {
                // A transfer like any other: submitted and recorded by the server in one step,
                // so it is in Transfers, is watched with no page open, and can be retried.
                const input = entry.isDir
                    ? {
                          _path: 'sync/copy',
                          srcFs: `${srcFs}${srcRemote}/`,
                          dstFs: `${dstFs}${dstRemote}`,
                          createEmptySrcDirs: true,
                      }
                    : { _path: 'operations/copyfile', srcFs, srcRemote, dstFs, dstRemote }

                const { id } = await startBatch(
                    [input],
                    { operation: 'download', sources: [entry.fullPath], destination: savePath },
                    { tags: ['commander'] }
                )
                handleJobStarted(id)
            } catch (error) {
                // Declining to reconnect a remote is an answer, not a failure to report.
                if (error instanceof UserCancelledError) return
                await reportError(error, {
                    title: 'Error',
                    fallback: 'Download failed',
                })
            }
        },
        [handleJobStarted]
    )

    // Rename and delete on a row, shared with the picker; both panels refresh afterwards.
    const { rename: handleRename, remove: handleDelete } = useEntryActions(refreshPanels)

    const handleShare = useCallback(async (entry: Entry) => {
        try {
            const { root, filePath } = getFsInfo(entry.fullPath)
            const result = await rclone('/operations/publiclink', {
                params: {
                    query: {
                        fs: root,
                        remote: filePath,
                    },
                },
            })
            if (result?.url) {
                await writeText(result.url)
                await notify({
                    title: 'Link Copied',
                    body: `Public link for "${entry.name}" copied to clipboard`,
                })
            }
        } catch (error) {
            await reportError(error, {
                title: 'Share Error',
                fallback: 'Failed to generate public link',
                okLabel: 'OK',
            })
        }
    }, [])

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                refreshPanels()
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [refreshPanels])

    return (
        <div className="flex flex-col w-full h-full overflow-hidden">
            <Group orientation="horizontal" className="flex-1">
                <Panel defaultSize={50} minSize={25}>
                    <FilePanel
                        ref={leftPanelRef}
                        sidebarPosition="left"
                        initialRemote="UI_LOCAL_FS"
                        selectionMode="both"
                        allowFiles={true}
                        allowMultiple={true}
                        showPreviewColumn={true}
                        onSelectionChange={setLeftSel}
                        onNavigate={handleLeftNavigate}
                        onDrop={(items, dest) => handleDrop(items, dest, 'left')}
                        onDownload={handleDownload}
                        onShare={handleShare}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        allowedKeys={['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA', 'FAVORITES']}
                        isActive={true}
                    />
                </Panel>

                <Separator className="w-1 transition-colors bg-divider hover:bg-primary-200 active:bg-primary-300" />

                <Panel defaultSize={50} minSize={25}>
                    <FilePanel
                        ref={rightPanelRef}
                        sidebarPosition="right"
                        initialRemote={
                            initialRightTarget.current?.remote ?? firstRemote ?? 'UI_LOCAL_FS'
                        }
                        initialPath={initialRightTarget.current?.path}
                        selectionMode="both"
                        allowFiles={true}
                        allowMultiple={true}
                        showPreviewColumn={true}
                        onSelectionChange={setRightSel}
                        onNavigate={handleRightNavigate}
                        onDrop={(items, dest) => handleDrop(items, dest, 'right')}
                        onDownload={handleDownload}
                        onShare={handleShare}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        allowedKeys={['REMOTES', 'LOCAL_FS', 'LOCAL_FS_EXTRA', 'FAVORITES']}
                        isActive={true}
                    />
                </Panel>
            </Group>

            <TransfersBar
                trackedIds={trackedIds}
                onOpenCompare={() => setCompareOpen(true)}
                compareDisabledReason={compareDisabledReason}
                onOpenBatchRename={handleOpenBatchRename}
                renameDisabledReason={renameDisabledReason}
            />

            <CompareDrawer
                isOpen={compareOpen}
                left={leftLoc}
                right={rightLoc}
                onClose={() => setCompareOpen(false)}
            />

            <BatchRenameDrawer
                isOpen={batchRenameOpen}
                items={batchRenameItems}
                onClose={() => setBatchRenameOpen(false)}
                onDone={handleBatchRenameDone}
            />

            <OperationDialog
                items={dropOperation?.items ?? null}
                destination={dropOperation?.destination ?? null}
                onClose={() => setDropOperation(null)}
                onComplete={refreshPanels}
                onJobStarted={handleJobStarted}
            />
        </div>
    )
}
