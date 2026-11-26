import { addToast } from '@heroui/react'
import { Check as CheckIcon, ExclamationTriangle as ExclamationTriangleIcon } from '@zappicon/react'
import { createElement, type ReactNode } from 'react'
import { IconTile } from './look/IconTile'
import type { Tone } from './look/tones'

const TOAST_LOOK = {
    variant: 'flat',
    radius: 'lg',
    classNames: {
        base: [
            'bg-content1 dark:bg-zinc-800 border-0 rounded-2xl px-3.5 py-3 gap-3',
            'shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_12px_32px_-8px_rgb(0_0_0/0.3)]',
            'dark:shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_12px_32px_-8px_rgb(0_0_0/0.7)]',
        ].join(' '),
        content: 'gap-x-3',
        title: 'text-[13px] font-semibold text-foreground',
        description: 'text-xs leading-snug text-default-500',
        progressIndicator: 'bg-default-400 opacity-10',
    },
} as const

function show(tone: Tone, icon: typeof CheckIcon, color: 'success' | 'warning') {
    return (title: string, description?: string, action?: ReactNode) =>
        addToast({
            title,
            description,
            endContent: action,
            color,
            icon: createElement(IconTile, { icon, tone, size: 'md' }),
            ...TOAST_LOOK,
        })
}

export function toastSuccess(title: string, description?: string, action?: ReactNode) {
    show('green', CheckIcon, 'success')(title, description, action)
}

export function toastWarning(title: string, description?: string, action?: ReactNode) {
    show('orange', ExclamationTriangleIcon, 'warning')(title, description, action)
}
