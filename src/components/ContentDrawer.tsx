import {
    Button,
    cn,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
    type DrawerProps,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Xmark as XmarkIcon } from '@zappicon/react'
import type { ComponentType, ReactNode } from 'react'
import { platform } from '../../lib/shell'
import { IconTile } from './look/IconTile'
import type { Tone } from './look/tones'

/** The drawer's surface: a little darker than the panels on it, so they stand out. */
const DRAWER_CLASSNAMES = {
    base: 'bg-[#f5f5f7] dark:bg-[#161618]',
    backdrop: 'bg-black/30 dark:bg-black/60',
}

/**
 * A drawer's header. Use it in a DrawerContent of your own, or give ContentDrawer a `title` for
 * the whole shell. `inset` leaves room for the window's buttons, which macOS draws over a
 * full-height drawer.
 */
export function DrawerShellHeader({
    icon,
    leading,
    tone = 'blue',
    title,
    description,
    actions,
    onClose,
    closeLabel = t`Close`,
    inset = false,
    className,
}: {
    icon?: ComponentType<{ className?: string }>
    /** Drawn in place of the tile, such as a file's own icon. */
    leading?: ReactNode
    tone?: Tone
    title: ReactNode
    description?: ReactNode
    actions?: ReactNode
    onClose?: () => void
    closeLabel?: string
    inset?: boolean
    className?: string
}) {
    return (
        <DrawerHeader
            className={cn(
                'flex items-center gap-3 px-5 py-3.5 border-b border-divider bg-content1/70 backdrop-blur-xl',
                inset && platform() === 'macos' && 'pt-10',
                className
            )}
        >
            {leading ?? (icon && <IconTile icon={icon} tone={tone} size="lg" />)}
            <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                <h2 className="text-[15px] font-semibold leading-tight truncate">{title}</h2>
                {description && (
                    <div className="text-xs font-normal leading-snug truncate text-default-500">
                        {description}
                    </div>
                )}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
            {onClose && (
                <Button
                    isIconOnly={true}
                    size="sm"
                    variant="light"
                    radius="full"
                    aria-label={closeLabel}
                    onPress={onClose}
                    className="shrink-0 text-default-500"
                >
                    <XmarkIcon className="size-[18px]" />
                </Button>
            )}
        </DrawerHeader>
    )
}

export function DrawerShellFooter({
    children,
    className,
}: {
    children: ReactNode
    className?: string
}) {
    return (
        <DrawerFooter
            className={cn(
                'gap-2 px-5 py-3 border-t border-divider bg-content1/70 backdrop-blur-xl',
                className
            )}
        >
            {children}
        </DrawerFooter>
    )
}

type ShellProps = {
    /** With a title, the drawer draws the shell around its children, which are the body. */
    title?: ReactNode
    icon?: ComponentType<{ className?: string }>
    tone?: Tone
    description?: ReactNode
    headerActions?: ReactNode
    footer?: ReactNode
    bodyClassName?: string
    contentClassName?: string
    closeLabel?: string
}

/**
 * HeroUI's Drawer, with every prop it takes. Without a `title`, its children are a DrawerContent,
 * as with HeroUI's. With one, its children are the body, and the drawer draws the header (with
 * the tile of `icon` and `tone`), the scrolling body and the `footer` around them.
 */
export default function ContentDrawer({
    title,
    icon,
    tone,
    description,
    headerActions,
    footer,
    bodyClassName,
    contentClassName,
    closeLabel,
    classNames,
    children,
    ...props
}: DrawerProps & ShellProps) {
    const merged = {
        ...classNames,
        base: cn(DRAWER_CLASSNAMES.base, classNames?.base),
        backdrop: cn(DRAWER_CLASSNAMES.backdrop, classNames?.backdrop),
    }
    if (title === undefined) {
        return (
            <Drawer {...props} classNames={merged}>
                {children}
            </Drawer>
        )
    }
    const fullHeight = props.size === 'full' || props.placement === 'left'
    return (
        <Drawer {...props} hideCloseButton={true} classNames={merged}>
            <DrawerContent className={contentClassName}>
                {(onClose) => (
                    <>
                        <DrawerShellHeader
                            icon={icon}
                            tone={tone}
                            title={title}
                            description={description}
                            actions={headerActions}
                            onClose={props.hideCloseButton ? undefined : onClose}
                            closeLabel={closeLabel}
                            inset={fullHeight}
                        />
                        <DrawerBody className={cn('px-5 py-5', bodyClassName)}>
                            {children}
                        </DrawerBody>
                        {footer && <DrawerShellFooter>{footer}</DrawerShellFooter>}
                    </>
                )}
            </DrawerContent>
        </Drawer>
    )
}
