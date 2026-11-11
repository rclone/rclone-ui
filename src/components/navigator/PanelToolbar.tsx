import { Button, Checkbox, cn, Input, Kbd, Tooltip } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowLeftSmall as ArrowLeftSmallIcon,
    ArrowsRotate as ArrowsRotateIcon,
    Search as SearchIcon,
    Xmark as XmarkIcon,
} from '@zappicon/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Fragment, type ReactNode } from 'react'

export type ToolbarButtons = {
    BackButton: ReactNode
    RefreshButton: ReactNode
    SearchInput: ReactNode
    NewFolderButton: ReactNode
}

/**
 * Where the panel's controls are drawn. `header` is the row above the list (the Commander's), with
 * compact icon buttons. `floating` is the toolbar that floats over the bottom of the list, which a
 * page that brings its own buttons (the path picker, through `renderToolbar`) uses.
 */
export type ControlsPlacement = 'header' | 'floating'

/** A panel button's tooltip, in the header or over the list: large, in the opposite color. */
export const TIP = { size: 'lg', color: 'foreground' } as const

/** A keyboard shortcut beside a tooltip's text. */
export function TipWithKeys({ text, keys }: { text: string; keys?: string }) {
    if (!keys) return text
    return (
        <span className="flex items-center gap-2">
            {text}
            <Kbd className="px-1.5 py-0 text-[11px] bg-background/15 text-background shadow-none">
                {keys}
            </Kbd>
        </span>
    )
}

export function BackButton({
    onBack,
    isDisabled,
    placement,
    keys,
}: {
    onBack: () => void
    isDisabled: boolean
    placement: ControlsPlacement
    keys?: string
}) {
    return (
        <Tooltip
            content={<TipWithKeys text={t`Go to parent folder`} keys={keys} />}
            {...TIP}
            closeDelay={0}
        >
            {placement === 'header' ? (
                <Button
                    isIconOnly={true}
                    size="sm"
                    variant="light"
                    radius="md"
                    aria-label={t({
                        message: 'Back',
                        comment: 'Button: goes to the parent folder.',
                    })}
                    onPress={onBack}
                    isDisabled={isDisabled}
                    className="text-default-600 shrink-0"
                >
                    <ArrowLeftSmallIcon className="size-5" />
                </Button>
            ) : (
                <Button
                    size="sm"
                    variant="flat"
                    radius="full"
                    onPress={onBack}
                    isDisabled={isDisabled}
                    startContent={<ArrowLeftSmallIcon className="size-4" />}
                    className="gap-1 pl-2.5 pr-3 font-semibold tracking-wide min-w-fit text-[11px]"
                >
                    {t({
                        message: 'BACK',
                        comment: 'Button: goes to the parent folder. Short, in capitals.',
                    })}
                </Button>
            )}
        </Tooltip>
    )
}

export function RefreshButton({
    onRefresh,
    isDisabled,
    isSpinning,
    placement,
    keys,
}: {
    onRefresh: () => void
    isDisabled: boolean
    isSpinning: boolean
    placement: ControlsPlacement
    keys?: string
}) {
    return (
        <Tooltip
            content={<TipWithKeys text={t`Refresh folder`} keys={keys} />}
            {...TIP}
            closeDelay={0}
        >
            <Button
                isIconOnly={true}
                size="sm"
                variant={placement === 'header' ? 'light' : 'flat'}
                radius={placement === 'header' ? 'md' : 'full'}
                aria-label={t`Refresh folder`}
                onPress={onRefresh}
                isDisabled={isDisabled}
                className={cn('shrink-0', placement === 'header' && 'text-default-600')}
            >
                <ArrowsRotateIcon
                    className={cn(
                        'size-4',
                        isSpinning && 'animate-spin motion-reduce:animate-none'
                    )}
                />
            </Button>
        </Tooltip>
    )
}

/**
 * The search field. While it has focus, an option under it (above it in the floating toolbar)
 * searches the sub-folders too, with a button that turns that off and leaves the field.
 */
export function SearchField({
    searchTerm,
    onSearchChange,
    searchInSubfolders,
    onSearchInSubfoldersChange,
    placement,
    inputRef,
}: {
    searchTerm: string
    onSearchChange: (term: string) => void
    searchInSubfolders: boolean
    onSearchInSubfoldersChange: (selected: boolean) => void
    placement: ControlsPlacement
    inputRef?: React.Ref<HTMLInputElement>
}) {
    const header = placement === 'header'
    return (
        // In a narrow panel's header, the field is a search button until it has focus or a term.
        <div
            data-filled={searchTerm !== ''}
            className={cn(
                'relative group/search shrink-0',
                header
                    ? [
                          'w-48 focus-within:w-60 transition-[width] duration-200 ease-out motion-reduce:transition-none',
                          '@max-lg:w-8 @max-lg:data-[filled=true]:w-32 @max-lg:focus-within:w-44',
                      ]
                    : 'w-48'
            )}
        >
            <div
                className={cn(
                    'absolute z-30 flex items-center invisible gap-1.5 opacity-0 pointer-events-none',
                    'transition-opacity duration-150 group-focus-within/search:visible group-focus-within/search:opacity-100 group-focus-within/search:pointer-events-auto',
                    header ? 'right-0 top-full mt-2' : '-left-2 bottom-full mb-3'
                )}
            >
                <div className="flex items-center h-8 pl-3 pr-3.5 rounded-full bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-6px_rgb(0_0_0/0.25)] dark:bg-zinc-800 dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_24px_-6px_rgb(0_0_0/0.6)]">
                    <Checkbox
                        size="sm"
                        isSelected={searchInSubfolders}
                        onValueChange={onSearchInSubfoldersChange}
                        classNames={{ label: 'text-xs whitespace-nowrap' }}
                    >
                        <Trans>Search in sub-folders</Trans>
                    </Checkbox>
                </div>
                <Button
                    isIconOnly={true}
                    size="sm"
                    radius="full"
                    variant="flat"
                    className="min-w-8 size-8 bg-content1 shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_8px_24px_-6px_rgb(0_0_0/0.25)] dark:bg-zinc-800"
                    aria-label={t`Close search options`}
                    onPress={() => {
                        onSearchInSubfoldersChange(false)
                        if (document.activeElement instanceof HTMLElement) {
                            document.activeElement.blur()
                        }
                    }}
                >
                    <XmarkIcon className="size-4" />
                </Button>
            </div>
            <Input
                ref={inputRef}
                size="sm"
                radius={header ? 'md' : 'full'}
                aria-label={t`Search this folder`}
                placeholder={t`Type here to search`}
                value={searchTerm}
                onValueChange={onSearchChange}
                isClearable={true}
                onClear={() => onSearchChange('')}
                startContent={<SearchIcon className="size-3.5 shrink-0 text-default-400" />}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
                classNames={{
                    base: 'w-full',
                    inputWrapper: cn(
                        header &&
                            'h-8 min-h-8 bg-default-100/80 dark:bg-default-100/60 @max-lg:px-2.5',
                        searchInSubfolders && 'ring-1 ring-inset ring-primary/50'
                    ),
                    input: 'text-[13px]',
                }}
            />
        </div>
    )
}

/**
 * The toolbar that floats over the bottom of a panel's list: groups of round buttons. A page
 * arranges the groups with `renderToolbar`, from the panel's own buttons and its own. Without
 * it, the panel shows back and refresh, then search and new folder.
 */
export default function PanelToolbar({
    onBack,
    onRefresh,
    isBackDisabled,
    isLoading,
    isRefreshing = false,
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
    /** The folder shown is being listed again. Its rows stay, and the refresh button spins. */
    isRefreshing?: boolean
    searchTerm: string
    onSearchChange: (term: string) => void
    searchInSubfolders: boolean
    onSearchInSubfoldersChange: (selected: boolean) => void
    renderToolbar?: (buttons: ToolbarButtons) => ReactNode[][]
    visible?: boolean
    newFolderButton?: ReactNode
}) {
    const reduceMotion = useReducedMotion()
    const buttons: ToolbarButtons = {
        BackButton: (
            <BackButton
                onBack={onBack}
                isDisabled={isBackDisabled || isLoading}
                placement="floating"
            />
        ),
        RefreshButton: (
            <RefreshButton
                onRefresh={onRefresh}
                isDisabled={isLoading || isRefreshing}
                isSpinning={isLoading || isRefreshing}
                placement="floating"
            />
        ),
        SearchInput: (
            <SearchField
                searchTerm={searchTerm}
                onSearchChange={onSearchChange}
                searchInSubfolders={searchInSubfolders}
                onSearchInSubfoldersChange={onSearchInSubfoldersChange}
                placement="floating"
            />
        ),
        NewFolderButton: newFolderButton ?? null,
    }
    const groups = renderToolbar
        ? renderToolbar(buttons)
        : [
              [buttons.BackButton, buttons.RefreshButton],
              [buttons.SearchInput, buttons.NewFolderButton],
          ]

    return (
        <div className="absolute left-0 right-0 z-20 flex justify-center w-full gap-3 pointer-events-none bottom-4">
            <AnimatePresence>
                {visible &&
                    groups.map((group, index) => (
                        <motion.div
                            key={index}
                            initial={reduceMotion ? { opacity: 0 } : { y: 24, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={reduceMotion ? { opacity: 0 } : { y: 24, opacity: 0 }}
                            transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
                            className={cn(
                                'flex flex-row items-center gap-1.5 p-1.5 rounded-full pointer-events-auto',
                                'bg-white/85 backdrop-blur-xl dark:bg-zinc-800/85',
                                'shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_10px_30px_-8px_rgb(0_0_0/0.3)]',
                                'dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_10px_30px_-8px_rgb(0_0_0/0.7)]'
                            )}
                        >
                            {group.map((button, slot) => (
                                // A group's slots are fixed, so their position is their key.
                                <Fragment key={slot}>{button}</Fragment>
                            ))}
                        </motion.div>
                    ))}
            </AnimatePresence>
        </div>
    )
}
