import {
    Button,
    Dropdown,
    DropdownItem,
    DropdownMenu,
    DropdownSection,
    DropdownTrigger,
} from '@heroui/react'
import { platform } from '@tauri-apps/plugin-os'
import { CommandIcon } from 'lucide-react'
import { openWindow } from '../../lib/window'

export default function CommandsDropdown({
    currentCommand,
    title,
}: { currentCommand?: string; title?: string }) {
    return (
        <Dropdown shadow={platform() === 'windows' ? 'none' : undefined}>
            <DropdownTrigger>
                <Button
                    size="lg"
                    type="button"
                    color="primary"
                    isIconOnly={!title}
                    // variant="faded"
                >
                    {title ? title : <CommandIcon className="size-6" />}
                </Button>
            </DropdownTrigger>
            <DropdownMenu
                onAction={async (key) => {
                    console.log(key)
                    const keyAsString = key as string
                    await openWindow({
                        name: keyAsString.slice(0, 1).toUpperCase() + keyAsString.slice(1),
                        url: `/${keyAsString}`,
                    })
                }}
                disabledKeys={currentCommand ? [currentCommand] : []}
                color="primary"
            >
                <DropdownSection title={title ? undefined : 'Run another command'}>
                    <DropdownItem key="download">Download</DropdownItem>
                    <DropdownItem key="copy">Copy</DropdownItem>
                    <DropdownItem key="move">Move</DropdownItem>
                    <DropdownItem key="delete">Delete</DropdownItem>
                    <DropdownItem key="sync">Sync</DropdownItem>
                    <DropdownItem key="bisync">Bisync</DropdownItem>
                    <DropdownItem key="purge">Purge</DropdownItem>
                    <DropdownItem key="serve">Serve</DropdownItem>
                    <DropdownItem key="mount">Mount</DropdownItem>
                </DropdownSection>
            </DropdownMenu>
        </Dropdown>
    )
}
