import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { Plus as PlusIcon } from '@zappicon/react'
import { useEffect, useState } from 'react'
import { useOperationDefaults } from '../../../lib/catalog'
import type { Mounts } from '../../../lib/core/types'
import { reportError } from '../../../lib/errors'
import {
    cannotMount,
    deleteAutomount,
    explainMountSupport,
    mountAutomount,
    saveAutomount,
    useAutomounts,
} from '../../../lib/mounts'
import { ask } from '../../../lib/shell'
import { ListWindow } from '../../components/list/ListWindow'
import { useDrawer } from '../../components/list/list'
import { toneButton } from '../../components/look/buttons'
import StartAtLoginNotice from '../../components/StartAtLoginNotice'
import { toastSuccess } from '../../components/toast'
import { usePageQuery, useSetPageQuery } from '../../route'
import { WINDOWS } from '../../routes'
import AutomountDrawer from './AutomountDrawer'
import AutomountRow, { type RowActions } from './AutomountRow'
import { sourceOf, splitSource } from './source'
import { deleteQuestion, searchFields, summaryOf } from './status'

type Automount = Mounts.AutomountRow

/** What the drawer opens on: an automount to edit, or for a new one, where to start. */
type Opened = { automount?: Automount; start?: { remote: string; remotePath: string } }

const LOOK = WINDOWS.automounts

/**
 * The drawer that the window opens with. The launcher opens `?action=create&source=gdrive:photos`
 * to add an automount of that folder.
 */
function openedOf(params: URLSearchParams): { item?: Opened; open?: boolean } | undefined {
    if (params.get('action') !== 'create') return undefined
    return { open: true, item: { start: splitSource(params.get('source') ?? '') } }
}

/**
 * The Automounts window. An automount mounts a folder of a remote each time the app starts, and a
 * remote can have several. The list follows the core's automounts.changed and mounts.changed
 * events.
 */
export default function Automounts() {
    const params = usePageQuery()
    const setParams = useSetPageQuery()
    const query = useAutomounts()
    const { drawer, open, close } = useDrawer<Opened>(openedOf(params))
    const defaults = useOperationDefaults('mount')
    const [mounting, setMounting] = useState<ReadonlySet<string>>(new Set())

    // The query is read once, when the window opens, so it is cleared from the address. The page
    // stays mounted, with its drawer open.
    useEffect(() => {
        setParams({ action: null, source: null })
    }, [setParams])

    const mountNow = async (a: Automount) => {
        setMounting((prev) => new Set(prev).add(a.id))
        try {
            await mountAutomount(a.id)
        } catch (error) {
            // On a computer that can't mount, the dialog explains how to set it up.
            if (cannotMount(error) && (await explainMountSupport().catch(() => false))) return
            await reportError(error, {
                title: t`Automount not mounted`,
                log: ['[Automounts] Automount not mounted'],
            })
        } finally {
            setMounting((prev) => {
                const next = new Set(prev)
                next.delete(a.id)
                return next
            })
        }
    }

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
                    onPress={() => open({})}
                >
                    <Trans>New automount</Trans>
                </Button>
            }
            empty={{
                title: t`No automounts yet`,
                description: t`An automount mounts a folder of a remote each time Rclone UI starts. A remote can have several, each at its own mount point.`,
                steps: STEPS,
            }}
            notice={<StartAtLoginNotice what="Automounts" />}
            noMatch={(search) => t`No automount has “${search}” in its source or mount point.`}
            row={(a) => (
                <AutomountRow
                    automount={a}
                    mounting={mounting.has(a.id)}
                    actions={rowActions(a, {
                        onEdit: () => open({ automount: a }),
                        onMountNow: () => mountNow(a),
                    })}
                />
            )}
            // The drawer shows a mount's defaults, which arrive with the catalog, so it waits for
            // them. Its fields are set once, when it opens, from the defaults that
            // useOptionGroups reads.
            drawers={
                defaults && (
                    <AutomountDrawer
                        key={drawer.key}
                        isOpen={drawer.isOpen}
                        onClose={close}
                        automount={drawer.item?.automount}
                        start={drawer.item?.start}
                    />
                )
            }
        />
    )
}

const STEPS = [
    t`Pick a remote, and a folder in it or the whole remote.`,
    t`Choose where it shows up on this computer.`,
    t`Each time Rclone UI starts, it mounts there.`,
]

/** The fields of an automount that the core saves, without what the row shows about it now. */
function saved(a: Automount): Mounts.Automount {
    return {
        id: a.id,
        remote: a.remote,
        remotePath: a.remotePath,
        mountPoint: a.mountPoint,
        options: a.options,
        enabled: a.enabled,
        createdAt: a.createdAt,
    }
}

function rowActions(a: Automount, page: Pick<RowActions, 'onEdit' | 'onMountNow'>): RowActions {
    return {
        ...page,
        onToggle: async (enabled) => {
            try {
                await saveAutomount({ ...saved(a), enabled })
            } catch (error) {
                const title = enabled ? t`Automount not turned on` : t`Automount not turned off`
                const log = `[Automounts] Automount not turned ${enabled ? 'on' : 'off'}`
                await reportError(error, { title, log: [log] })
            }
        },
        onDelete: async () => {
            const sure = await ask(deleteQuestion(a), {
                title: t`Delete automount`,
                kind: 'warning',
                destructive: true,
                okLabel: t({ message: 'Delete', comment: 'Button: deletes the automount.' }),
                cancelLabel: t`Cancel`,
            })
            if (!sure) return
            try {
                await deleteAutomount(a.id)
            } catch (error) {
                await reportError(error, {
                    title: t`Automount not deleted`,
                    log: ['[Automounts] Automount not deleted'],
                })
                return
            }
            const source = sourceOf(a)
            toastSuccess(t`Deleted the automount of ${source}`)
        },
    }
}
