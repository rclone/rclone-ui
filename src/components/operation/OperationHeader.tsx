import { type ComponentProps, type ReactNode, useState } from 'react'
import type { Operations } from '../../../lib/core/types'
import type { TemplateTag } from '../../../lib/templates'
import CommandsDropdown from '../CommandsDropdown'
import { WindowHeader } from '../look/WindowHeader'
import { CommandModal } from './CommandModal'
import { pageLook } from './look'
import TemplatesDropdown from './TemplatesDropdown'

/** The page of an rclone command on rclone.org, such as `copy` or `serve_webdav`. */
export function rcloneDocsUrl(command: string): string {
    return `https://rclone.org/commands/rclone_${command}/`
}

/**
 * The top of an operation page: its tile and name, the sentence that says what it does, and on
 * the right the page's Templates menu and its More menu. The page's route gives its look (WINDOWS
 * in src/routes.ts).
 */
export default function OperationHeader({
    operation,
    intro,
    docs = rcloneDocsUrl(operation),
    templates,
    command,
    preview,
}: {
    operation: TemplateTag | 'download'
    intro: ReactNode
    /** The docs that the More menu opens. Defaults to the operation's command page. */
    docs?: string
    /** The Templates menu, on pages that keep templates. */
    templates?: Omit<ComponentProps<typeof TemplatesDropdown>, 'operation'>
    /** The page's operation for a script, which Copy command shows (useOperationSubmission). */
    command: () => Promise<Operations.Script>
    /** The preview (a dry run), on the pages that offer one (useOperationSubmission). */
    preview?: ComponentProps<typeof CommandsDropdown>['preview']
}) {
    const [showCommand, setShowCommand] = useState(false)
    return (
        <>
            <WindowHeader
                look={pageLook()}
                description={intro}
                actions={
                    <>
                        {templates && operation !== 'download' && (
                            <TemplatesDropdown operation={operation} {...templates} />
                        )}
                        <CommandsDropdown
                            currentCommand={operation}
                            docs={docs}
                            preview={preview}
                            onCopyCommand={() => setShowCommand(true)}
                        />
                    </>
                }
            />
            <CommandModal
                isOpen={showCommand}
                onClose={() => setShowCommand(false)}
                command={command}
            />
        </>
    )
}
