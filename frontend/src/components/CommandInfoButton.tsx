import { Button, Tooltip } from '@heroui/react'
import { BookOpenTextIcon } from 'lucide-react'
import { rcloneDocsUrl } from '../../lib/rclone/constants'

/** A link to rclone's own documentation for the subcommand this page runs. */
export default function CommandInfoButton({ command }: { command: string }) {
    return (
        <Tooltip content="Rclone docs" placement="top" size="lg" color="foreground">
            <Button
                as="a"
                href={rcloneDocsUrl(command)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Rclone docs"
                size="lg"
                color="primary"
                isIconOnly={true}
            >
                <BookOpenTextIcon className="size-6" />
            </Button>
        </Tooltip>
    )
}
