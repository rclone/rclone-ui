import { Button, Drawer, DrawerBody, DrawerContent, DrawerHeader, Tooltip, cn } from '@heroui/react'

import { BookOpenTextIcon } from 'lucide-react'
import { startTransition, useState } from 'react'
import { rcloneDocsUrl } from '../../lib/rclone/constants'

export default function CommandInfoButton({
    content,
    command,
}: {
    content: string
    /** The rclone subcommand this page runs, for the link a browser tab gets. */
    command: string
}) {
    const [isOpen, setIsOpen] = useState(false)

    // rclone's own documentation is fuller than any prose here and stays current.
    {
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

    return (
        <>
            <Tooltip content={'View documentation'} placement="top" size="lg" color="foreground">
                <Button
                    onPress={() => {
                        startTransition(() => {
                            setIsOpen((prev) => !prev)
                        })
                    }}
                    size="lg"
                    type="button"
                    color="primary"
                    // variant="faded"
                    isIconOnly={true}
                >
                    <BookOpenTextIcon className="size-6" />
                </Button>
            </Tooltip>

            <Drawer
                isOpen={isOpen}
                onClose={() => {
                    startTransition(() => {
                        setIsOpen(false)
                    })
                }}
                size="full"
                placement={'bottom'}
            >
                <DrawerContent
                    className={cn(
                        'bg-content1/80 backdrop-blur-md dark:bg-content1/90',
                        undefined
                    )}
                >
                    <DrawerHeader>Documentation</DrawerHeader>
                    <DrawerBody className="pb-20 whitespace-pre-wrap text-large">
                        {content}
                    </DrawerBody>
                </DrawerContent>
            </Drawer>
        </>
    )
}
