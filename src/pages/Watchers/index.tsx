import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Plus as PlusIcon } from '@zappicon/react'
import type { Watchers as Core } from '../../../lib/core/types'
import { reportError } from '../../../lib/errors'
import { useNow } from '../../../lib/format'
import { ask } from '../../../lib/shell'
import { ListWindow } from '../../components/list/ListWindow'
import { useDrawer } from '../../components/list/list'
import { toneButton } from '../../components/look/buttons'
import StartAtLoginNotice from '../../components/StartAtLoginNotice'
import { toastSuccess } from '../../components/toast'
import { WINDOWS } from '../../routes'
import { deleteQuestion, deletesCopy, resyncQuestion, searchFields, summaryOf } from './status'
import WatcherDrawer from './WatcherDrawer'
import WatcherRow, { type RowActions } from './WatcherRow'
import {
    deleteWatcher,
    forceWatcher,
    resyncWatcher,
    setWatcherPaused,
    syncWatcherNow,
    useWatchers,
} from './watchers'

type Watcher = Core.Watcher

const LOOK = WINDOWS.watchers

/**
 * The Watchers window. A watcher keeps two folders the same with a bisync every minute. The list
 * follows the core's watchers.changed events.
 */
export default function Watchers() {
    const query = useWatchers()
    const now = useNow()
    const { drawer, open, close } = useDrawer<Watcher>()

    return (
        <ListWindow
            look={LOOK}
            query={query}
            fields={searchFields}
            summary={summaryOf(query.data ?? [])}
            action={
                <Button
                    color="primary"
                    className={toneButton(LOOK.tone)}
                    startContent={<PlusIcon className="size-4" />}
                    onPress={() => open()}
                >
                    <Trans>New watcher</Trans>
                </Button>
            }
            empty={{
                title: t`No watchers yet`,
                description: t`A watcher keeps two folders the same, like Dropbox or Google Drive. Either folder can be on this computer or on a remote.`,
                steps: STEPS,
            }}
            notice={<StartAtLoginNotice what="Watchers" />}
            noMatch={(search) => t`No watcher is named like “${search}”.`}
            row={(w) => <WatcherRow watcher={w} now={now} actions={rowActions(w, () => open(w))} />}
            drawers={
                <WatcherDrawer
                    key={drawer.key}
                    isOpen={drawer.isOpen}
                    onClose={close}
                    watcher={drawer.item}
                />
            }
        />
    )
}

const STEPS = [
    t`Pick two folders, on this computer or on remotes.`,
    t`The first sync merges them. Nothing is deleted.`,
    t`Then every minute, what changed in one is copied to the other.`,
]

/** `title` is for the error dialog. `log` says in English what failed, for the log. */
async function call(fn: () => Promise<void>, title: string, log: string) {
    try {
        await fn()
    } catch (error) {
        await reportError(error, { title, log: [`[Watchers] ${log}`] })
    }
}

function rowActions(w: Watcher, onEdit: () => void): RowActions {
    const name = w.name
    return {
        onPause: (paused) =>
            paused
                ? call(() => setWatcherPaused(w.id, true), t`Watcher not paused`, 'not paused')
                : call(() => setWatcherPaused(w.id, false), t`Watcher not resumed`, 'not resumed'),
        onSyncNow: () => call(() => syncWatcherNow(w.id), t`Watcher not synced`, 'not synced'),
        onEdit,
        onResync: async () => {
            const sure = await ask(resyncQuestion(w), {
                title: t`Resync ${name}`,
                okLabel: t({
                    message: 'Resync',
                    comment: "Button: merges a watcher's two folders again, as its first sync did.",
                }),
                cancelLabel: t`Cancel`,
            })
            if (sure) await call(() => resyncWatcher(w.id), t`Watcher not resynced`, 'not resynced')
        },
        onForce: async () => {
            const sure = await ask(deletesCopy(w).deleteQuestion, {
                title: t`Delete files`,
                kind: 'warning',
                destructive: true,
                okLabel: t`Delete them`,
                cancelLabel: t`Cancel`,
            })
            if (sure)
                await call(() => forceWatcher(w.id), t`Files not deleted`, 'files not deleted')
        },
        onDelete: async () => {
            const sure = await ask(deleteQuestion(w), {
                title: t`Delete ${name}`,
                kind: 'warning',
                destructive: true,
                okLabel: t`Delete watcher`,
                cancelLabel: t`Keep it`,
            })
            if (!sure) return
            try {
                await deleteWatcher(w.id)
            } catch (error) {
                await reportError(error, {
                    title: t`Watcher not deleted`,
                    log: ['[Watchers] not deleted'],
                })
                return
            }
            toastSuccess(t`Deleted ${name}`)
        },
    }
}
