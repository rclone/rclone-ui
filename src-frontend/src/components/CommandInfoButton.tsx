import { Button, Drawer, DrawerBody, DrawerContent, DrawerHeader, Tooltip, cn } from '@heroui/react'

import { BookOpenTextIcon } from 'lucide-react'
import { startTransition, useState } from 'react'
import { useIsDesktop } from '../../lib/api/host'
import { isNativeMac } from '../../lib/api/os'
import { rcloneDocsUrl } from '../../lib/rclone/constants'

export default function CommandInfoButton({
    content,
    command,
}: {
    content: string
    /** The rclone subcommand this page runs, for the link a browser tab gets. */
    command: string
}) {
    const isDesktop = useIsDesktop()
    const [isOpen, setIsOpen] = useState(false)

    // A native window has nowhere to open a page, so it carries its own prose in a sheet. A
    // browser tab has somewhere: rclone's own documentation, which is fuller and stays current.
    if (!isDesktop) {
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
                        isNativeMac ? 'pt-4' : undefined
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
