import { Button, cn, Drawer, DrawerBody, DrawerContent, Textarea } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { FileText as FileTextIcon } from '@zappicon/react'
import { useEffect, useState } from 'react'
import {
    type ConfigFile,
    ConfigStatus,
    readConfigText,
    useConfigText,
    writeConfigText,
} from '../../../../lib/configs'
import { formatErrorMessage, onErrorDialog, refusedFields } from '../../../../lib/errors'
import Alert from '../../../components/Alert'
import { toneButton } from '../../../components/look/buttons'
import { IconTile } from '../../../components/look/IconTile'
import { SectionTitle } from '../../../components/look/SectionTitle'
import {
    SHEET_COLUMN,
    SheetFooter,
    SheetHeader,
    sheetClass,
} from '../../../components/SettingsWindow'
import { toastSuccess } from '../../../components/toast'
import { useUnsavedChanges } from '../../../components/unsaved'
import { WINDOWS } from '../../../routes'
import ConfigPanel from './ConfigPanel'

/**
 * The sheet for the config file: its encryption and export (ConfigPanel), and an editor for its
 * text. The editor is the only place where the app writes the config file itself. The core checks
 * the text first, and rclone then reloads the file.
 */
export default function ConfigDrawer({
    onClose,
    isOpen,
    config,
}: {
    onClose: () => void
    isOpen: boolean
    config: ConfigFile | null
}) {
    // The form reports whether it holds changes. Closing the drawer or the window asks first.
    const [edited, setEdited] = useState(false)
    const unsaved = useUnsavedChanges(isOpen && edited)
    const requestClose = async () => {
        if (await unsaved.confirm()) onClose()
    }
    return (
        <Drawer
            isOpen={isOpen}
            placement="bottom"
            size="full"
            onClose={requestClose}
            hideCloseButton={true}
        >
            <DrawerContent className={sheetClass()}>
                {(close) =>
                    config ? (
                        <EditForm
                            config={config}
                            close={close}
                            onEdited={setEdited}
                            forget={unsaved.forget}
                        />
                    ) : (
                        <Header />
                    )
                }
            </DrawerContent>
        </Drawer>
    )
}

const showSaveError = onErrorDialog(t`Could not save config`)

function EditForm({
    config,
    close,
    onEdited,
    forget,
}: {
    config: ConfigFile
    close: () => void
    onEdited: (edited: boolean) => void
    forget: () => void
}) {
    const [text, setText] = useState<string | null>(null)
    // The text that the first edit started from. The query refetches on focus, so a save checks
    // the file against this text, not against what the query holds by then.
    const [base, setBase] = useState('')

    // The text of a locked config is encrypted, so it can only be edited once it is unlocked.
    const readable =
        config.status !== ConfigStatus.StatusNeedsPassword &&
        config.status !== ConfigStatus.StatusMissing
    const textQuery = useConfigText(readable)
    const shownText = text ?? textQuery.data ?? ''
    // Why the core refused the text. It shows under the editor until the text changes.
    const [textError, setTextError] = useState<string>()

    const onTextChange = (value: string) => {
        if (text === null) setBase(textQuery.data ?? '')
        setText(value)
        setTextError(undefined)
    }

    const edited = text !== null && text !== base
    useEffect(() => {
        onEdited(edited)
    }, [edited, onEdited])
    useEffect(() => () => onEdited(false), [onEdited])

    const saveMutation = useMutation({
        mutationFn: async () => {
            // If the text couldn't be read, there is nothing to write.
            if (!textQuery.isSuccess || text === null || text === base) return
            const current = await readConfigText()
            if (current !== base) {
                throw new Error(
                    t`The file changed on disk after you opened it (a sign-in was refreshed, or another program saved it). Close the editor and open it again, then redo your change.`
                )
            }
            await writeConfigText(text)
        },
        onSuccess: () => {
            forget()
            close()
            toastSuccess(t`The config was saved.`)
        },
        onError: (error) => {
            const refused = refusedFields(error).text
            if (refused) {
                setTextError(refused)
                return
            }
            return showSaveError(error)
        },
    })

    return (
        <>
            <Header />
            <DrawerBody>
                <div className={cn(SHEET_COLUMN, 'flex flex-col gap-6 py-2')}>
                    <ConfigPanel />
                    <section aria-labelledby="config-text" className="flex flex-col gap-3">
                        <SectionTitle
                            id="config-text"
                            title={t({
                                message: 'Text',
                                comment: "Title of the editor of the config file's text.",
                            })}
                            description={
                                readable && !textQuery.isError
                                    ? t`Renaming a section deletes that remote and makes a new one, and whatever used the old one stops working. To rename a remote, use its edit page.`
                                    : undefined
                            }
                        />
                        {readable && textQuery.isError ? (
                            <Alert color="danger" variant="faded" title={t`The text can't be read`}>
                                <p className="text-small">{formatErrorMessage(textQuery.error)}</p>
                            </Alert>
                        ) : readable ? (
                            <Textarea
                                aria-label={t({
                                    message: 'Content',
                                    comment: "The config file's text, in an editor.",
                                })}
                                value={shownText}
                                onValueChange={onTextChange}
                                minRows={16}
                                maxRows={40}
                                isDisabled={!textQuery.isSuccess}
                                isInvalid={!!textError}
                                errorMessage={textError}
                                classNames={{
                                    input: 'font-mono text-small leading-relaxed',
                                    inputWrapper: 'p-4',
                                }}
                                spellCheck="false"
                            />
                        ) : (
                            <p className="px-4 py-6 text-center rounded-2xl text-small text-default-500 bg-default-100/60">
                                {config.status === ConfigStatus.StatusMissing
                                    ? t`The file isn't there yet. Rclone makes it when a remote is added.`
                                    : t`Unlock the config to edit its text.`}
                            </p>
                        )}
                    </section>
                </div>
            </DrawerBody>
            <SheetFooter>
                <Button variant="flat" onPress={close}>
                    <Trans>Close</Trans>
                </Button>
                <Button
                    color="primary"
                    className={toneButton(WINDOWS.remotes.tone)}
                    isLoading={saveMutation.isPending}
                    isDisabled={!edited}
                    onPress={() => saveMutation.mutate()}
                >
                    <Trans>Save changes</Trans>
                </Button>
            </SheetFooter>
        </>
    )
}

function Header() {
    return (
        <SheetHeader
            tile={<IconTile icon={FileTextIcon} tone={WINDOWS.remotes.tone} size="xl" />}
            title={t`Config file`}
            description={t`Rclone's own config file, which the rclone command in your terminal uses too.`}
        />
    )
}
