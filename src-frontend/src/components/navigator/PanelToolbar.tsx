import { Button, Checkbox, Input, Tooltip } from '@heroui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeftIcon, RefreshCwIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type ToolbarButtons = {
    BackButton: ReactNode
    RefreshButton: ReactNode
    SearchInput: ReactNode
    NewFolderButton: ReactNode
}

export default function PanelToolbar({
    onBack,
    onRefresh,
    isBackDisabled,
    isLoading,
    searchTerm,
    onSearchChange,
    searchInSubfolders,
    onSearchInSubfoldersChange,
    renderToolbar,
    visible = true,
    newFolderButton,
}: {
    onBack: () => void
    onRefresh: () => void
    isBackDisabled: boolean
    isLoading: boolean
    searchTerm: string
    onSearchChange: (term: string) => void
    searchInSubfolders: boolean
    onSearchInSubfoldersChange: (selected: boolean) => void
    renderToolbar?: (buttons: ToolbarButtons) => ReactNode[][]
    visible?: boolean
    newFolderButton?: ReactNode
}) {
    const BackButton = (
        <Tooltip content="Go to parent directory" size="lg" color="foreground">
            <Button
                color="primary"
                size="sm"
                onPress={onBack}
                isDisabled={isBackDisabled || isLoading}
                radius="full"
                startContent={<ArrowLeftIcon className="size-5" />}
                className="gap-1 min-w-fit"
            >
                BACK
            </Button>
        </Tooltip>
    )

    const RefreshButton = (
        <Tooltip content="Refresh directory" size="lg" color="foreground">
            <Button
                color="primary"
                size="sm"
                onPress={onRefresh}
                isDisabled={isLoading}
                radius="full"
                isIconOnly={true}
            >
                <RefreshCwIcon className={`size-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
        </Tooltip>
    )

    const SearchInput = (
        <div className="relative w-48 group">
            <div className="absolute z-20 flex items-center invisible gap-2 mb-3 transition-opacity opacity-0 pointer-events-none -left-2 bottom-full group-focus-within:visible group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
                <div className="px-3.5 pt-0.5 pb-1.5 rounded-full bg-content2 shadow-medium">
                    <Checkbox
                        size="sm"
                        isSelected={searchInSubfolders}
                        onValueChange={onSearchInSubfoldersChange}
                        classNames={{ label: 'text-xs whitespace-nowrap' }}
                    >
                        Search in sub-folders
                    </Checkbox>
                </div>
                <Button
                    isIconOnly={true}
                    color="danger"
                    size="sm"
                    radius="full"
                    className="min-w-7 size-7"
                    aria-label="Close search options"
                    onPress={() => {
                        onSearchInSubfoldersChange(false)
                        if (document.activeElement instanceof HTMLElement) {
                            document.activeElement.blur()
                        }
                    }}
                >
                    <XIcon className="size-4" />
                </Button>
            </div>
            <Input
                size="sm"
                radius="full"
                placeholder="Type here to search"
                value={searchTerm}
                onValueChange={onSearchChange}
                isClearable={true}
                onClear={() => onSearchChange('')}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
                classNames={{
                    base: 'w-full',
                }}
            />
        </div>
    )

    const NewFolderButton = newFolderButton ?? null
    const buttons: ToolbarButtons = { BackButton, RefreshButton, SearchInput, NewFolderButton }
    const groups = renderToolbar
        ? renderToolbar(buttons)
        : [
              [BackButton, RefreshButton],
              [SearchInput, NewFolderButton],
          ]

    const motionTransition = {
        enter: {
            type: 'spring',
            stiffness: 300,
            damping: 20,
            delay: 0.69,
        },
        exit: {
            duration: 0.2,
            delay: 0,
        },
    }

    return (
        <div className="absolute left-0 right-0 flex justify-center w-full gap-4 bottom-5">
            <AnimatePresence>
                {visible &&
                    groups.map((group, index) => (
                        <motion.div
                            key={index}
                            initial={{ y: 100, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={{ y: 100, opacity: 0 }}
                            transition={motionTransition}
                            className="flex flex-row items-center gap-2.5 px-2 py-1.5 rounded-full bg-content2"
                        >
                            {group}
                        </motion.div>
                    ))}
            </AnimatePresence>
        </div>
    )
}
