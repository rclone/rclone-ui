import {
    Button,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
    Select,
    SelectItem,
    Switch,
    Tooltip,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import {
    ExclamationTriangle as ExclamationTriangleIcon,
    Folder as FolderIcon,
} from '@zappicon/react'
import { useCallback, useId, useMemo, useState } from 'react'
import type { Mounts, Operations } from '../../../lib/core/types'
import { formatErrorMessage, refusedFields } from '../../../lib/errors'
import { saveAutomount } from '../../../lib/mounts'
import { pathProblem } from '../../../lib/paths'
import { useRemoteNames } from '../../../lib/remotes'
import { homeDir, platform } from '../../../lib/shell'
import { drawerContentClass, SheetHeader } from '../../components/list/drawer'
import { toneButton } from '../../components/look/buttons'
import { Panel } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { CATEGORY_META, OptionsSection } from '../../components/operation/OptionsAccordion'
import { type GroupKey, OPTION_GROUPS } from '../../components/operation/optionGroups'
import { useOptionGroups } from '../../components/operation/useOptionGroups'
import { useOptionItems } from '../../components/operation/useOptionItems'
import { bareField, PathField, RouteLink, RoutePanel, RouteRow } from '../../components/PathFinder'
import PathSelector from '../../components/PathSelector'
import { useUnsavedChanges } from '../../components/unsaved'
import { useReportEdited } from '../../route'
import { WINDOWS } from '../../routes'
import { isDrive, mountPointOf, suggestedMountPoint } from '../Mount/mountPoint'
import { splitSource } from './source'

const GROUPS = ['mount', 'vfs', 'config', 'filter'] as const satisfies readonly GroupKey[]

type Group = (typeof GROUPS)[number]

const LOOK = WINDOWS.automounts
/** The route is a mount's, so it has the Mount window's colors. */
const MOUNT = WINDOWS.mount

/** The fields that the core can refuse, by the names it uses. */
type Field = 'remote' | 'remotePath' | 'mountPoint' | `options.${Group}`

const FIELDS: ReadonlySet<string> = new Set<Field>([
    'remote',
    'remotePath',
    'mountPoint',
    ...GROUPS.map((group) => `options.${group}` as const),
])

/** What the core said about a save: the fields it refused, or one message for the whole form. */
type Refused = Partial<Record<Field, string>> & { form?: string }

/**
 * The drawer's fields, apart from the option groups. `mountPoint` is undefined until the user
 * edits it, so the suggestion shows.
 */
interface Form {
    remote: string
    remotePath: string
    mountPoint: string | undefined
    enabled: boolean
}

function formOf(
    automount: Mounts.AutomountRow | undefined,
    start: { remote: string; remotePath: string } | undefined
): Form {
    return {
        remote: automount?.remote ?? start?.remote ?? '',
        remotePath: automount?.remotePath ?? start?.remotePath ?? '',
        mountPoint: automount?.mountPoint,
        enabled: automount?.enabled ?? true,
    }
}

/**
 * The drawer that adds an automount, or edits `automount`. `start` fills in the remote and the
 * folder of a new one. Each option editor shows a mount's defaults with the saved options over
 * them, as the Mount page does. The core checks the form, and probes the folder when the
 * automount is on. An error that it gives for a field shows on that field.
 */
export default function AutomountDrawer({
    isOpen,
    onClose,
    automount,
    start,
}: {
    isOpen: boolean
    onClose: () => void
    automount?: Mounts.AutomountRow
    start?: { remote: string; remotePath: string }
}) {
    const editing = !!automount
    const windows = platform() === 'windows'
    const names = useRemoteNames()

    const [initial] = useState(() => formOf(automount, start))
    const [form, setForm] = useState(initial)
    const optionState = useOptionGroups({
        operation: 'mount',
        groups: GROUPS,
        initial: automount?.options,
    })
    const { groups } = optionState
    const [refused, setRefused] = useState<Refused>({})
    const [picking, setPicking] = useState(false)
    const startLabel = useId()

    // A new automount mounts at ~/Rclone/<remote> until the user picks a place. On Windows, an
    // empty mount point is the next free drive letter.
    const suggestion = form.remote
        ? suggestedMountPoint(form.remote, homeDir(), windows)
        : undefined
    const mountPoint = mountPointOf(form.mountPoint, suggestion, windows) ?? ''

    // A remote that is gone from the config stays in the choices, so the form still shows it.
    const remotes = useMemo(
        () => (form.remote && !names.includes(form.remote) ? [form.remote, ...names] : names),
        [names, form.remote]
    )

    const edited = optionState.edited || JSON.stringify(form) !== JSON.stringify(initial)
    const unsaved = useUnsavedChanges(isOpen && edited)
    useReportEdited(isOpen && edited)
    const requestClose = async () => {
        if (await unsaved.confirm()) onClose()
    }

    const save = useMutation({
        mutationFn: saveAutomount,
        onSuccess: () => {
            unsaved.forget()
            onClose()
        },
        onError: (error) => {
            const fields = refusedFields(error)
            // A refusal of a field that the drawer doesn't show, such as a metadata mapper
            // without `metadata`, is shown as the form's message.
            const names = Object.keys(fields)
            if (names.length > 0 && names.every((name) => FIELDS.has(name))) {
                setRefused(fields as Partial<Record<Field, string>>)
                return
            }
            console.error('[AutomountDrawer] not saved', error)
            setRefused({ form: formatErrorMessage(error, t`The automount could not be saved.`) })
        },
    })

    const submit = () => {
        const broken: Refused = {}
        for (const group of GROUPS) {
            if (groups[group].valid) continue
            const { title } = CATEGORY_META[OPTION_GROUPS[group].category]
            broken[`options.${group}`] = t({
                message: `The ${title} options are not valid JSON.`,
                comment: '{title} is the name of a group of options, such as VFS or Filters.',
            })
        }
        if (Object.keys(broken).length > 0) {
            setRefused(broken)
            return
        }
        // Saved option groups that the drawer doesn't edit (such as metadata) are kept. The
        // others are saved without the defaults, which the core adds when it mounts.
        const options: Operations.Groups = { ...automount?.options }
        for (const group of GROUPS) options[group] = groups[group].sent
        save.mutate({
            id: automount?.id ?? '',
            remote: form.remote,
            remotePath: form.remotePath.trim(),
            mountPoint,
            options,
            enabled: form.enabled,
            createdAt: automount?.createdAt ?? 0,
        })
    }

    // Changing a field clears the error the core gave it, and the form's message.
    const clear = useCallback((...fields: Field[]) => {
        setRefused((prev) => {
            const out = { ...prev, form: undefined }
            for (const field of fields) out[field] = undefined
            return out
        })
    }, [])
    const change = (next: Partial<Form>, ...fields: Field[]) => {
        setForm((prev) => ({ ...prev, ...next }))
        clear(...fields)
    }
    const clearGroup = useCallback((group: Group) => clear(`options.${group}`), [clear])

    // Each group's error shows under its editor, and a group with an error opens.
    const errors = useMemo(
        () => Object.fromEntries(GROUPS.map((group) => [group, refused[`options.${group}`]])),
        [refused]
    )
    const optionItems = useOptionItems(optionState, { errors, onEdit: clearGroup })

    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={requestClose}
            hideCloseButton={true}
        >
            <DrawerContent className={drawerContentClass(platform() === 'macos')}>
                <DrawerHeader className="px-6 pt-5 pb-4">
                    <div className="w-full max-w-3xl mx-auto">
                        <SheetHeader
                            look={LOOK}
                            title={editing ? t`Edit automount` : t`New automount`}
                            description={t`Mounts a folder of a remote each time Rclone UI starts.`}
                        />
                    </div>
                </DrawerHeader>
                <DrawerBody className="px-6 pt-2 pb-6">
                    <form
                        className="flex flex-col w-full max-w-3xl gap-6 mx-auto"
                        onSubmit={(e) => {
                            e.preventDefault()
                            submit()
                        }}
                    >
                        <section className="flex flex-col gap-2.5">
                            <SectionTitle
                                title={t`What and where`}
                                description={t`A path on a remote, and where it appears locally on your computer.`}
                                className="px-1"
                            />
                            <RoutePanel
                                tone={MOUNT.tone}
                                note={{
                                    kind: 'info',
                                    text: windows
                                        ? t`A drive letter like M:, or empty for the next free one.`
                                        : t`An empty folder. It is made if it is missing.`,
                                }}
                            >
                                <RouteRow stop="from" tone={MOUNT.tone}>
                                    <div className="flex items-start gap-1">
                                        <Select
                                            label={t`Remote`}
                                            placeholder={t`Choose a remote`}
                                            selectedKeys={form.remote ? [form.remote] : []}
                                            disallowEmptySelection={true}
                                            onSelectionChange={(keys) => {
                                                const picked = [...keys][0]
                                                if (picked !== undefined) {
                                                    change(
                                                        { remote: String(picked) },
                                                        'remote',
                                                        'remotePath'
                                                    )
                                                }
                                            }}
                                            isInvalid={!!refused.remote}
                                            errorMessage={refused.remote}
                                            description={
                                                remotes.length === 0
                                                    ? t`Add a remote in the Remotes window first.`
                                                    : undefined
                                            }
                                            className="w-56 shrink-0"
                                            classNames={{
                                                trigger: bareField(!!refused.remote).inputWrapper,
                                                label: 'font-medium text-default-500',
                                                helperWrapper: 'px-3 pb-1.5',
                                            }}
                                        >
                                            {remotes.map((name) => (
                                                <SelectItem key={name}>{name}</SelectItem>
                                            ))}
                                        </Select>
                                        <Input
                                            label={t`Folder`}
                                            placeholder={t`The whole remote`}
                                            value={form.remotePath}
                                            onValueChange={(remotePath) =>
                                                change({ remotePath }, 'remotePath')
                                            }
                                            isInvalid={!!refused.remotePath}
                                            errorMessage={refused.remotePath}
                                            classNames={bareField(!!refused.remotePath)}
                                            className="flex-1 min-w-0"
                                            autoComplete="off"
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                            spellCheck="false"
                                        />
                                        <Tooltip
                                            content={t`Pick a folder`}
                                            delay={500}
                                            closeDelay={0}
                                        >
                                            <Button
                                                isIconOnly={true}
                                                variant="flat"
                                                aria-label={t`Pick a folder`}
                                                onPress={() => setPicking(true)}
                                                className="mt-2 size-12 min-w-12 rounded-[10px] shrink-0 text-default-600 data-[hover=true]:text-foreground"
                                                data-focus-visible="false"
                                            >
                                                <FolderIcon className="size-[22px]" />
                                            </Button>
                                        </Tooltip>
                                    </div>
                                </RouteRow>
                                <RouteLink tone={MOUNT.tone} />
                                <RouteRow stop="to" tone={MOUNT.tone}>
                                    <PathField
                                        label={t`Mount point`}
                                        path={form.mountPoint ?? suggestion ?? ''}
                                        setPath={(path) =>
                                            change({ mountPoint: path }, 'mountPoint')
                                        }
                                        placeholder={
                                            windows
                                                ? t`Next free drive letter`
                                                : t`The folder to mount the remote at`
                                        }
                                        allowedKeys={['LOCAL_FS', 'LOCAL_FS_EXTRA']}
                                        showFiles={false}
                                        problemOf={(path) =>
                                            isDrive(path, windows) ? undefined : pathProblem(path)
                                        }
                                        bare={true}
                                    />
                                    {refused.mountPoint && (
                                        <p className="px-3 pb-2 text-tiny text-danger">
                                            {refused.mountPoint}
                                        </p>
                                    )}
                                </RouteRow>
                            </RoutePanel>
                        </section>

                        <Panel className="flex items-center gap-6 px-5 py-4">
                            <div className="flex flex-col flex-1 gap-0.5">
                                <span id={startLabel} className="font-medium text-small">
                                    <Trans>Mount each time Rclone UI starts</Trans>
                                </span>
                                {!form.enabled && (
                                    <span className="text-xs leading-relaxed text-default-500">
                                        <Trans>It is saved, but off until you turn it on.</Trans>
                                    </span>
                                )}
                            </div>
                            <Switch
                                size="sm"
                                isSelected={form.enabled}
                                onValueChange={(enabled) =>
                                    change({ enabled }, 'remotePath', 'mountPoint')
                                }
                                aria-labelledby={startLabel}
                                data-focus-visible="false"
                                classNames={{ wrapper: 'me-0' }}
                            />
                        </Panel>

                        <OptionsSection
                            items={optionItems}
                            defaultExpandedKeys={GROUPS.filter((group) => errors[group])}
                        />
                        {/* Enter in a field saves. */}
                        <button type="submit" hidden={true} />
                    </form>
                    {picking && (
                        <PathSelector
                            isOpen={picking}
                            onClose={() => setPicking(false)}
                            onSelect={(items) => {
                                setPicking(false)
                                const picked = items[0] && splitSource(items[0].path)
                                if (picked) change(picked, 'remote', 'remotePath')
                            }}
                            initialPaths={form.remote ? [`${form.remote}:${form.remotePath}`] : []}
                            allowedKeys={['REMOTES']}
                            mode="folders"
                            allowMultiple={false}
                        />
                    )}
                </DrawerBody>
                <DrawerFooter className="flex-col items-stretch gap-3 px-6">
                    {refused.form && (
                        <div className="flex w-full max-w-3xl gap-2.5 p-3 mx-auto rounded-xl bg-danger/10 text-small">
                            <ExclamationTriangleIcon className="size-4 mt-px shrink-0 text-danger-600 dark:text-danger-400" />
                            <p className="break-words text-danger-700 dark:text-danger-400">
                                {refused.form}
                            </p>
                        </div>
                    )}
                    <div className="flex justify-end w-full max-w-3xl gap-2 mx-auto">
                        <Button variant="light" onPress={requestClose} data-focus-visible="false">
                            <Trans>Cancel</Trans>
                        </Button>
                        <Button
                            color="primary"
                            className={toneButton(LOOK.tone)}
                            isLoading={save.isPending}
                            onPress={submit}
                            data-focus-visible="false"
                        >
                            {editing ? t`Save changes` : t`Add automount`}
                        </Button>
                    </div>
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
    )
}
