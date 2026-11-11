import {
    Button,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    Input,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { Watchers } from '../../../lib/core/types'
import { formatErrorMessage, refusedFields } from '../../../lib/errors'
import { message, platform } from '../../../lib/shell'
import { drawerContentClass, SheetHeader } from '../../components/list/drawer'
import { toneButton } from '../../components/look/buttons'
import { Panel } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { pickerFor } from '../../components/operation/places'
import {
    bareField,
    PATH_PLACEHOLDER,
    PathField,
    PICK_PLACEHOLDER,
    RouteLink,
    RoutePanel,
    RouteRow,
} from '../../components/PathFinder'
import { useUnsavedChanges } from '../../components/unsaved'
import { WINDOWS } from '../../routes'
import { saveWatcher } from './watchers'

const HELP = t`Every minute, what changed in either folder is updated in the other. The first run merges them, which means that files missing on one side are copied over, and where both have a file, the newer one is kept. Nothing is deleted then.`
const MOVED = t`Changing a folder merges the two folders again on the next sync.`

type Fields = 'name' | 'pathA' | 'pathB'

const LOOK = WINDOWS.watchers

/**
 * The drawer that creates a watcher, or edits `watcher`. The core checks the form, and a refused
 * field shows its error on the field.
 */
export default function WatcherDrawer({
    isOpen,
    onClose,
    watcher,
}: {
    isOpen: boolean
    onClose: () => void
    watcher?: Watchers.Watcher
}) {
    const editing = !!watcher
    const [name, setName] = useState(watcher?.name ?? '')
    const [pathA, setPathA] = useState(watcher?.pathA ?? '')
    const [pathB, setPathB] = useState(watcher?.pathB ?? '')
    const [refused, setRefused] = useState<Partial<Record<Fields, string>>>({})

    const moved = editing && (pathA.trim() !== watcher.pathA || pathB.trim() !== watcher.pathB)
    const edited = editing
        ? name !== watcher.name || moved
        : name.trim() !== '' || pathA.trim() !== '' || pathB.trim() !== ''
    const unsaved = useUnsavedChanges(isOpen && edited)

    const requestClose = async () => {
        if (await unsaved.confirm()) onClose()
    }

    const save = useMutation({
        mutationFn: () => saveWatcher({ id: watcher?.id ?? '', name, pathA, pathB }),
        onSuccess: () => {
            unsaved.forget()
            onClose()
        },
        onError: async (error) => {
            const fields = refusedFields(error)
            if (fields.name || fields.pathA || fields.pathB) {
                setRefused({ name: fields.name, pathA: fields.pathA, pathB: fields.pathB })
                return
            }
            await message(formatErrorMessage(error, t`The watcher could not be saved.`), {
                title: editing ? t`Watcher not saved` : t`Watcher not created`,
                kind: 'error',
            })
        },
    })

    // Typing in a field clears the error the core gave it.
    const edit = (field: Fields, set: (value: string) => void) => (value: string) => {
        set(value)
        setRefused((prev) => ({ ...prev, [field]: undefined }))
    }

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
                            title={titleOf(watcher)}
                            description={t`Keeps two folders the same, on this computer or on remotes.`}
                        />
                    </div>
                </DrawerHeader>
                <DrawerBody className="px-6 pt-2 pb-6">
                    <form
                        className="flex flex-col w-full max-w-3xl gap-6 mx-auto"
                        onSubmit={(e) => {
                            e.preventDefault()
                            save.mutate()
                        }}
                    >
                        <Panel className="p-1.5">
                            <Input
                                label={t`Name`}
                                placeholder={t({
                                    message: 'Photos, Work notes…',
                                    comment: 'Examples of names for a watcher.',
                                })}
                                classNames={bareField(!!refused.name)}
                                value={name}
                                onValueChange={edit('name', setName)}
                                isInvalid={!!refused.name}
                                errorMessage={refused.name}
                                autoFocus={!editing}
                                autoComplete="off"
                                autoCorrect="off"
                                spellCheck="false"
                            />
                        </Panel>
                        <section className="flex flex-col gap-2.5">
                            <SectionTitle title={t`Folders`} description={HELP} className="px-1" />
                            <RoutePanel
                                tone={LOOK.tone}
                                note={moved ? { kind: 'warning', text: MOVED } : undefined}
                            >
                                <RouteRow stop="from" tone={LOOK.tone} filled={true}>
                                    <WatcherPath
                                        label={t`Folder A`}
                                        placeholder={PICK_PLACEHOLDER}
                                        path={pathA}
                                        setPath={edit('pathA', setPathA)}
                                        error={refused.pathA}
                                    />
                                </RouteRow>
                                <RouteLink tone={LOOK.tone} />
                                <RouteRow stop="to" tone={LOOK.tone}>
                                    <WatcherPath
                                        label={t`Folder B`}
                                        placeholder={PATH_PLACEHOLDER}
                                        path={pathB}
                                        setPath={edit('pathB', setPathB)}
                                        error={refused.pathB}
                                    />
                                </RouteRow>
                            </RoutePanel>
                        </section>
                        {/* Enter in a field saves. */}
                        <button type="submit" hidden={true} />
                    </form>
                </DrawerBody>
                <DrawerFooter className="px-6">
                    <div className="flex justify-end w-full max-w-3xl gap-2 mx-auto">
                        <Button variant="light" onPress={requestClose} data-focus-visible="false">
                            <Trans>Cancel</Trans>
                        </Button>
                        <Button
                            color="primary"
                            className={toneButton(LOOK.tone)}
                            isLoading={save.isPending}
                            onPress={() => save.mutate()}
                            data-focus-visible="false"
                        >
                            {editing ? t`Save changes` : t`Create watcher`}
                        </Button>
                    </div>
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
    )
}

function titleOf(watcher: Watchers.Watcher | undefined): string {
    if (!watcher) return t`New watcher`
    const name = watcher.name
    return t`Edit ${name}`
}

function WatcherPath({
    label,
    placeholder,
    path,
    setPath,
    error,
}: {
    label: string
    placeholder: string
    path: string
    setPath: (path: string) => void
    error?: string
}) {
    return (
        <div className="flex flex-col gap-1">
            <PathField
                label={label}
                placeholder={placeholder}
                path={path}
                setPath={setPath}
                showFiles={false}
                allowedKeys={pickerFor('bisync', 'source').allowedKeys}
                bare={true}
            />
            {error && <p className="px-3 pb-2 text-tiny text-danger">{error}</p>}
        </div>
    )
}
