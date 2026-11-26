import { type ComponentProps, type ReactNode, useState } from 'react'
import type { Operations } from '../../../lib/core/types'
import type { TemplateTag } from '../../../lib/templates'
import CommandsDropdown from '../CommandsDropdown'
import { WindowHeader } from '../look/WindowHeader'
import { CommandModal } from './CommandModal'
import { pageLook } from './look'
import TemplatesDropdown from './TemplatesDropdown'

export function rcloneDocsUrl(command: string): string {
    return `https://rclone.org/commands/rclone_${command}/`
}

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
    docs?: string
    templates?: Omit<ComponentProps<typeof TemplatesDropdown>, 'operation'>
    command: () => Promise<Operations.Script>
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
